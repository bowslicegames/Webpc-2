/* QEMU-Wasm adapter for the WebPC display ABI.
 *
 * Expected native exports (to be added to the QEMU-Wasm build):
 *   webpc_get_framebuffer_ptr() -> byte offset in HEAPU8
 *   webpc_get_framebuffer_width() -> integer
 *   webpc_get_framebuffer_height() -> integer
 *   webpc_get_framebuffer_generation() -> integer (increments after each completed frame)
 *   webpc_send_input(type, code, x, y, buttons) -> 0 on success
 *
 * This adapter intentionally reports a missing ABI instead of pretending
 * that a normal Emscripten QEMU build can provide frames by itself.
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
    pollHandle = window.setInterval(copyFrame, 1000 / 15);
    window.WebPCGraphicsBridge.setInputSink(sendInput);
    report("QEMU display ABI connected; waiting for first guest frame…");
    return { connected: true, missing: [] };
  }

  function copyFrame() {
    if (!attached || !moduleRef) return;
    try {
      const w = moduleRef._webpc_get_framebuffer_width() | 0;
      const h = moduleRef._webpc_get_framebuffer_height() | 0;
      const generation = moduleRef._webpc_get_framebuffer_generation() | 0;
      if (generation === lastGeneration || w < 1 || h < 1 || w * h > MAX_PIXELS) return;
      const ptr = moduleRef._webpc_get_framebuffer_ptr() >>> 0;
      const bytes = w * h * 4;
      if (!moduleRef.HEAPU8 || ptr + bytes > moduleRef.HEAPU8.length) {
        report("QEMU framebuffer pointer is outside WebAssembly memory");
        return;
      }
      const frame = new Uint8Array(bytes);
      frame.set(moduleRef.HEAPU8.subarray(ptr, ptr + bytes));
      window.WebPCGraphicsBridge.presentFrame({ width: w, height: h, pixels: frame });
      lastGeneration = generation;
      report("Guest display connected · " + w + "×" + h + " · frame " + generation);
    } catch (error) {
      report("Guest framebuffer error: " + (error && error.message ? error.message : String(error)));
    }
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
    if (window.WebPCGraphicsBridge) window.WebPCGraphicsBridge.setInputSink(null);
  }

  window.WebPCQemuGraphics = Object.freeze({ connect, disconnect });
})();
