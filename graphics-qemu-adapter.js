/* QEMU-Wasm adapter for the WebPC display ABI.
 *
 * Expected native exports (to be added to the QEMU-Wasm build):
 *   webpc_get_framebuffer_ptr() -> byte offset in HEAPU8
 *   webpc_get_framebuffer_width() -> integer
 *   webpc_get_framebuffer_height() -> integer
 *   webpc_get_framebuffer_generation() -> integer (increments after each completed frame)
 *   webpc_send_input(type, code, x, y, buttons) -> 0 on success
 *
 * The matching QEMU patch exports the framebuffer ABI and consumes the
 * keyboard, pointer, wheel and touch-look input queue.
 */
(() => {
  "use strict";
  let moduleRef = null;
  let lastGeneration = -1;
  let attached = false;
  let pollHandle = 0;
  let canvas = null;
  let status = null;
  const MAX_PIXELS = 4096 * 4096;

  function report(message) {
    if (status) status.textContent = message;
    window.dispatchEvent(new CustomEvent("webpc-graphics-status", { detail: message }));
  }

  function connect(mod, targetCanvas, statusNode) {
    disconnect();
    moduleRef = mod;
    canvas = targetCanvas;
    status = statusNode || null;
    if (!window.WebPCGraphicsBridge || !canvas) throw new Error("Display bridge or canvas missing");
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
      report("QEMU display ABI missing: " + missing.join(", ") + ". Rebuild QEMU with qemu-webpc-display patch.");
      return { connected: false, missing };
    }
    attached = true;
    lastGeneration = -1;
    pollHandle = window.setInterval(copyFrame, 1000 / 30);
    window.WebPCGraphicsBridge.setInputSink(sendInput);
    canvas.tabIndex = 0;
    canvas.style.outlineOffset = "2px";
    canvas.addEventListener("pointerdown", onPointer);
    canvas.addEventListener("pointermove", onPointer);
    canvas.addEventListener("pointerup", onPointer);
    canvas.addEventListener("pointercancel", onPointer);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKey);
    canvas.addEventListener("keyup", onKey);
    report("QEMU display ABI connected; waiting for first guest frame…");
    return { connected: true, missing: [] };
  }

  function copyFrame() {
    if (!attached || !moduleRef) return;
    try {
      /* Read the sequence counter before touching dimensions or pixels. */
      const generation = moduleRef._webpc_get_framebuffer_generation() >>> 0;
      if (generation === lastGeneration || (generation & 1)) return;
      const w = moduleRef._webpc_get_framebuffer_width() | 0;
      const h = moduleRef._webpc_get_framebuffer_height() | 0;
      if (w < 1 || h < 1 || w * h > MAX_PIXELS) return;
      const ptr = moduleRef._webpc_get_framebuffer_ptr() >>> 0;
      const bytes = w * h * 4;
      if (!moduleRef.HEAPU8 || ptr + bytes > moduleRef.HEAPU8.length) {
        report("QEMU framebuffer pointer is outside WebAssembly memory");
        return;
      }
      const frame = new Uint8Array(bytes);
      frame.set(moduleRef.HEAPU8.subarray(ptr, ptr + bytes));
      const completedGeneration = moduleRef._webpc_get_framebuffer_generation() >>> 0;
      if (completedGeneration !== generation || (completedGeneration & 1)) return;
      window.WebPCGraphicsBridge.presentFrame({ width: w, height: h, pixels: frame });
      lastGeneration = completedGeneration;
      report("Guest display connected · " + w + "×" + h + " · frame " + generation);
    } catch (error) {
      report("Guest framebuffer error: " + (error && error.message ? error.message : String(error)));
    }
  }

  function onPointer(event) {
    if (!canvas) return;
    if (event.type === "pointerdown") canvas.focus();
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - rect.left) * canvas.width / Math.max(1, rect.width))));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - rect.top) * canvas.height / Math.max(1, rect.height))));
    window.WebPCGraphicsBridge.sendInput({
      type: "pointer", codeValue: event.button, x, y,
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

  function sendInput(event) {
    if (!attached || !moduleRef) return false;
    const type = event.type === "pointer" ? 2 : event.type === "key" ? 1 : 0;
    const code = Number(event.codeValue || 0) | 0;
    const x = Number(event.x || 0) | 0;
    const y = Number(event.y || 0) | 0;
    const buttons = Number(event.buttons || 0) | 0;
    return moduleRef._webpc_send_input(type, code, x, y, buttons) === 0;
  }

  function disconnect() {
    if (pollHandle) window.clearInterval(pollHandle);
    pollHandle = 0;
    attached = false;
    moduleRef = null;
    if (canvas) {
      canvas.removeEventListener("pointerdown", onPointer);
      canvas.removeEventListener("pointermove", onPointer);
      canvas.removeEventListener("pointerup", onPointer);
      canvas.removeEventListener("pointercancel", onPointer);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKey);
      canvas.removeEventListener("keyup", onKey);
    }
    if (window.WebPCGraphicsBridge) window.WebPCGraphicsBridge.setInputSink(null);
    canvas = null;
    status = null;
  }

  window.WebPCQemuGraphics = Object.freeze({ connect, disconnect, sendInput, sendKeyCode });
})();
