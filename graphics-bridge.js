/* WebPC guest display bridge.
 * This is a transport endpoint, not a guest GPU. QEMU must call
 * WebPCGraphicsBridge.presentFrame() with guest framebuffer pixels before
 * any Linux-generated image can appear here.
 */
(() => {
  "use strict";
  const state = {
    canvas: null, context: null, width: 0, height: 0,
    frames: 0, lastFrameAt: 0, sink: null, stopped: false
  };

  function attach(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError("A canvas is required");
    const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!context) throw new Error("2D canvas context unavailable");
    state.canvas = canvas;
    state.context = context;
    state.stopped = false;
    return getStats();
  }

  function presentFrame(frame) {
    if (state.stopped) return false;
    if (!state.context) throw new Error("Attach a display canvas before presenting frames");
    if (!frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
        frame.width < 1 || frame.height < 1 || frame.width > 4096 || frame.height > 4096) {
      throw new RangeError("Invalid guest framebuffer dimensions (1–4096)");
    }
    const pixels = frame.pixels;
    const expected = frame.width * frame.height * 4;
    if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) || pixels.byteLength !== expected) {
      throw new TypeError("Expected exactly width × height × 4 RGBA bytes");
    }
    if (state.canvas.width !== frame.width || state.canvas.height !== frame.height) {
      state.canvas.width = frame.width;
      state.canvas.height = frame.height;
    }
    const image = new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, expected), frame.width, frame.height);
    state.context.putImageData(image, 0, 0);
    state.width = frame.width;
    state.height = frame.height;
    state.frames++;
    state.lastFrameAt = performance.now();
    return true;
  }

  function setInputSink(callback) {
    if (callback !== null && typeof callback !== "function") throw new TypeError("Input sink must be a function or null");
    state.sink = callback;
  }

  function sendInput(event) {
    if (!state.sink || state.stopped) return false;
    state.sink(Object.freeze({ ...event, timestamp: performance.now() }));
    return true;
  }

  function getStats() {
    return Object.freeze({
      attached: !!state.canvas, width: state.width, height: state.height,
      frames: state.frames, lastFrameAt: state.lastFrameAt,
      fpsWindow: state.frames ? state.frames : 0,
      inputConnected: !!state.sink, stopped: state.stopped
    });
  }

  function stop() {
    state.stopped = true;
    state.sink = null;
  }

  window.WebPCGraphicsBridge = Object.freeze({ attach, presentFrame, setInputSink, sendInput, getStats, stop });
})();
