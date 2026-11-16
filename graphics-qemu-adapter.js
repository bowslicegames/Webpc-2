/* QEMU-Wasm adapter for the WebPC display ABI.
 *
 * Expected native exports (present in the WebPC QEMU-Wasm build):
 *   webpc_get_framebuffer_ptr() -> byte offset in HEAPU8
 *   webpc_get_framebuffer_width() -> integer
 *   webpc_get_framebuffer_height() -> integer
 *   webpc_get_framebuffer_generation() -> integer (increments after each completed frame)
 *   webpc_send_input(type, code, x, y, buttons) -> 0 on success
 *
 * The QEMU patch exposes the framebuffer ABI, drives a bounded frame pump and
 * consumes the keyboard, pointer, wheel and touch-look input queue.
 */
(() => {
  "use strict";
  let moduleRef = null;
  let lastGeneration = -1;
  let attached = false;
  let pollHandle = 0;
  let canvas = null;
  let status = null;
  let frameBuffer = null;
  let frameBufferBytes = 0;
  let framesPresented = 0;
  let lastPresentAt = 0;
  let lastFrameSize = "";
  let lastError = "";
  let lastReportAt = 0;
  let lastReported = "";
  let presentTimes = [];
  let connectedAt = 0;
  let reportedNoFrames = false;
  let lastNoFrameHint = "";
  const pressedKeys = new Set();
  const MAX_PIXELS = 4096 * 4096;
  const POLL_INTERVAL_MS = 1000 / 30;
  function abiSnapshot() {
    try {
      if (!moduleRef) return "abi=detached";
      const gen = moduleRef._webpc_get_framebuffer_generation() >>> 0;
      const w = moduleRef._webpc_get_framebuffer_width() | 0;
      const h = moduleRef._webpc_get_framebuffer_height() | 0;
      const ptr = moduleRef._webpc_get_framebuffer_ptr() >>> 0;
      return "gen=" + gen + " w=" + w + " h=" + h + " ptr=" + (ptr ? "set" : "null");
    } catch (_) {
      return "abi=unreadable";
    }
  }

  function noFrameHint() {
    return "QEMU display ABI is connected but no guest frame arrived in 20 s [" +
      abiSnapshot() + "]. Frozen native values mean the running QEMU runtime " +
      "is not publishing frames; changing values with a blank canvas mean the " +
      "presenter is not uploading.";
  }
  const DOCUMENT = typeof document !== "undefined" ? document : null;

  function report(message, force) {
    const now = performance.now();
    if (!force && message === lastReported) return;
    if (!force && now - lastReportAt < 500) return;
    lastReportAt = now;
    lastReported = message;
    if (status) status.textContent = message;
    window.dispatchEvent(new CustomEvent("webpc-graphics-status", { detail: message }));
  }

  function reportError(message) {
    if (message === lastError) return;
    lastError = message;
    report(message, true);
  }

  function connect(mod, targetCanvas, statusNode) {
    disconnect();
    moduleRef = mod;
    canvas = targetCanvas;
    status = statusNode || null;
    if (!window.WebPCGraphicsBridge || !canvas) throw new Error("Display bridge or canvas missing");
    /* attach() is idempotent, so the page's early attach is reused here
       instead of creating a second WebGL context. */
    window.WebPCGraphicsBridge.attach(canvas);
    const required = [
      "_webpc_get_framebuffer_ptr",
      "_webpc_get_framebuffer_width",
      "_webpc_get_framebuffer_height",
      "_webpc_get_framebuffer_generation",
      "_webpc_send_input"
    ];
    const missing = required.filter(name => typeof mod[name] !== "function");
    if (missing.length) {
      report("QEMU display ABI missing: " + missing.join(", ") + ". Rebuild QEMU with qemu-webpc-display patch.", true);
      return { connected: false, missing };
    }
    attached = true;
          lastGeneration = -1;
    lastFrameSize = "";
    lastError = "";
    lastReported = "";
    framesPresented = 0;
    connectedAt = performance.now();
    reportedNoFrames = false;
    lastNoFrameHint = "";
    presentTimes = [];
    window.WebPCGraphicsBridge.setInputSink(sendInput);
    canvas.tabIndex = 0;
    canvas.style.outlineOffset = "2px";
    canvas.addEventListener("pointerdown", onPointer);
    canvas.addEventListener("pointermove", onPointer);
    canvas.addEventListener("pointerup", onPointer);
    canvas.addEventListener("pointercancel", onPointer);
    canvas.addEventListener("lostpointercapture", onPointer);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKey);
    canvas.addEventListener("keyup", onKey);
    window.addEventListener("blur", releaseKeys);
    DOCUMENT?.addEventListener("visibilitychange", onVisibilityChange);
    startPolling();
    report("QEMU display ABI connected; waiting for first guest frame…", true);
    return { connected: true, missing: [] };
  }

  function startPolling() {
    if (pollHandle || !attached) return;
    if (DOCUMENT && DOCUMENT.hidden) return;
    pollHandle = window.setInterval(copyFrame, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (!pollHandle) return;
    window.clearInterval(pollHandle);
    pollHandle = 0;
  }

  function onVisibilityChange() {
    if (!attached) return;
    if (DOCUMENT && DOCUMENT.hidden) {
      /* A background tab must not keep copying guest frames, and held
         movement keys must be released so the guest does not walk away. */
      stopPolling();
      releaseKeys();
    } else {
      startPolling();
      copyFrame();
    }
  }

  function copyFrame() {
    if (!attached || !moduleRef) return;
    try {
      /* Read the sequence counter before touching dimensions or pixels. */
      const generation = moduleRef._webpc_get_framebuffer_generation() >>> 0;
      if ((generation === lastGeneration || (generation & 1)) &&
          !reportedNoFrames && performance.now() - connectedAt > 20000) {
        /* The ABI is present but the running binary never produced a frame:
           this is what a QEMU build that predates the frame pump looks like. */
        reportedNoFrames = true;
        lastNoFrameHint = noFrameHint();
        reportError(lastNoFrameHint);
      }
      if (generation === lastGeneration || (generation & 1)) return;
      const w = moduleRef._webpc_get_framebuffer_width() | 0;
      const h = moduleRef._webpc_get_framebuffer_height() | 0;
      if (w < 1 || h < 1 || w * h > MAX_PIXELS) return;
      const ptr = moduleRef._webpc_get_framebuffer_ptr() >>> 0;
      const bytes = w * h * 4;
      if (!moduleRef.HEAPU8 || ptr + bytes > moduleRef.HEAPU8.length) {
        reportError("QEMU framebuffer pointer is outside WebAssembly memory");
        return;
      }
      /* Reuse one copy buffer instead of allocating ~1 MB per frame. The
         presenter uploads synchronously, so the same buffer is safe. */
      if (!frameBuffer || frameBufferBytes !== bytes) {
        frameBuffer = new Uint8Array(bytes);
        frameBufferBytes = bytes;
      }
      frameBuffer.set(moduleRef.HEAPU8.subarray(ptr, ptr + bytes));
      const completedGeneration = moduleRef._webpc_get_framebuffer_generation() >>> 0;
      if (completedGeneration !== generation || (completedGeneration & 1)) return;
      const presented = window.WebPCGraphicsBridge.presentFrame({ width: w, height: h, pixels: frameBuffer });
      if (!presented) {
        /* The presenter is rate-limited or its context was lost. Keep the
           generation unread so this frame is retried on the next poll. */
        return;
      }
      lastGeneration = completedGeneration;
      framesPresented++;
      if (lastNoFrameHint && lastError === lastNoFrameHint) {
        lastError = "";
        lastReported = "";
        lastNoFrameHint = "";
      }
      const now = performance.now();
      lastPresentAt = now;
      presentTimes.push(now);
      presentTimes = presentTimes.filter(t => now - t < 1000);
      const size = w + "×" + h;
      if (size !== lastFrameSize) {
        lastFrameSize = size;
        lastError = "";
        report("Guest display live · " + size + " · " + presentTimes.length + " FPS", true);
      }
    } catch (error) {
      reportError("Guest framebuffer error: " + (error && error.message ? error.message : String(error)));
    }
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - rect.left) * canvas.width / Math.max(1, rect.width)))),
      y: Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - rect.top) * canvas.height / Math.max(1, rect.height))))
    };
  }

  function onPointer(event) {
    if (!canvas) return;
    if (event.type === "pointerdown") {
      canvas.focus();
      /* Keep receiving move events when a finger or mouse leaves the canvas,
         so a drag-look does not stall at the canvas edge. */
      try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
    }
    if (event.type === "lostpointercapture") return;
    const point = canvasPoint(event);
    window.WebPCGraphicsBridge.sendInput({
      type: "pointer", codeValue: event.button, x: point.x, y: point.y,
      buttons: event.type === "pointerup" || event.type === "pointercancel" ? 0 : event.buttons
    });
    if (event.cancelable) event.preventDefault();
  }

  function onWheel(event) {
    if (!canvas) return;
    if (event.cancelable) event.preventDefault();
    sendInput({ type: "pointer", codeValue: 253, x: event.deltaY < 0 ? -1 : 1, y: 0, buttons: 0 });
  }

  function browserKeyToLinux(code) {
    const map = {
      8:14, 9:15, 13:28, 16:42, 17:29, 18:56, 27:1, 32:57,
      33:104, 34:109, 35:107, 36:102, 37:105, 38:103, 39:106, 40:108,
      45:110, 46:111, 48:11, 49:2, 50:3, 51:4, 52:5, 53:6, 54:7, 55:8, 56:9, 57:10,
      112:59, 113:60, 114:61, 115:62, 116:63, 117:64, 118:65, 119:66, 120:67, 121:68, 122:87, 123:88,
      65:30, 66:48, 67:46, 68:32, 69:18, 70:33, 71:34, 72:35, 73:23, 74:36,
      75:37, 76:38, 77:50, 78:49, 79:24, 80:25, 81:16, 82:19, 83:31, 84:20,
      85:22, 86:47, 87:17, 88:45, 89:21, 90:44,
      91:125, 93:126, 186:39, 187:13, 188:51, 189:12, 190:52, 191:53,
      192:41, 219:26, 220:43, 221:27, 222:40
    };
    return map[Number(code)] || 0;
  }

  function onKey(event) {
    window.WebPCGraphicsBridge.sendInput({
      type: "key", codeValue: browserKeyToLinux(event.keyCode || 0),
      buttons: event.type === "keydown" ? 1 : 0
    });
    if (event.cancelable) event.preventDefault();
  }

  function sendKeyCode(browserCode, down) {
    return sendInput({ type: "key", codeValue: browserKeyToLinux(browserCode), buttons: down ? 1 : 0 });
  }

  function releaseKeys() {
    if (!attached || !moduleRef) return;
    for (const code of pressedKeys) sendInput({ type: "key", codeValue: code, buttons: 0 });
    pressedKeys.clear();
  }

  function sendInput(event) {
    if (!attached || !moduleRef) return false;
    const type = event.type === "pointer" ? 2 : event.type === "key" ? 1 : 0;
    const code = Number(event.codeValue || 0) | 0;
    const x = Number(event.x || 0) | 0;
    const y = Number(event.y || 0) | 0;
    const buttons = Number(event.buttons || 0) | 0;
    if (type === 1 && code) {
      if (buttons) pressedKeys.add(code);
      else pressedKeys.delete(code);
    }
    return moduleRef._webpc_send_input(type, code, x, y, buttons) === 0;
  }

  function nativeGeneration() {
    try {
      if (!moduleRef) return -1;
      return moduleRef._webpc_get_framebuffer_generation() >>> 0;
    } catch (_) {
      return -1;
    }
  }

  function getStats() {
    return Object.freeze({
      connected: attached,
      abi: attached ? abiSnapshot() : "detached",
      nativeGeneration: attached ? nativeGeneration() : -1,
      width: lastFrameSize ? Number(lastFrameSize.split("×")[0]) : 0,
      height: lastFrameSize ? Number(lastFrameSize.split("×")[1]) : 0,
      generation: lastGeneration,
      framesPresented,
      fps: presentTimes.length,
      lastFrameAt: lastPresentAt,
      lastError
    });
  }

  function disconnect() {
    stopPolling();
    releaseKeys();
    attached = false;
    moduleRef = null;
    frameBuffer = null;
    frameBufferBytes = 0;
    if (canvas) {
      canvas.removeEventListener("pointerdown", onPointer);
      canvas.removeEventListener("pointermove", onPointer);
      canvas.removeEventListener("pointerup", onPointer);
      canvas.removeEventListener("pointercancel", onPointer);
      canvas.removeEventListener("lostpointercapture", onPointer);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKey);
      canvas.removeEventListener("keyup", onKey);
    }
    window.removeEventListener("blur", releaseKeys);
    DOCUMENT?.removeEventListener("visibilitychange", onVisibilityChange);
    if (window.WebPCGraphicsBridge) window.WebPCGraphicsBridge.setInputSink(null);
    canvas = null;
    status = null;
  }

  window.WebPCQemuGraphics = Object.freeze({ connect, disconnect, sendInput, sendKeyCode, getStats });
})();
