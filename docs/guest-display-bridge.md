# Guest display bridge (experimental)

This branch now contains a browser-side RGBA framebuffer endpoint:

- `graphics-bridge.js` attaches a 2D canvas and accepts bounded RGBA frames.
- `presentFrame({width, height, pixels})` copies a guest frame to the canvas.
- `setInputSink(callback)` / `sendInput(event)` provide the host-side input boundary.
- The Minecraft window exposes the display surface and a diagnostics button.
- `tools/test-graphics-bridge.cjs` validates frame dimensions, byte lengths, rendering, input forwarding and stop behavior.

## Current hard limitation

The bridge is not connected to QEMU. The current checked-in QEMU runtime remains serial-only and does not export a framebuffer callback. Therefore the canvas intentionally remains blank and diagnostics report zero frames until a rebuilt QEMU display backend calls `WebPCGraphicsBridge.presentFrame`.

This is not a virtual GPU and does not translate OpenGL. It is the browser-side display transport boundary needed before guest display integration.

## Required next integration

1. Rebuild the patched QEMU-Wasm runtime with a display device/backend that exposes guest scanout updates to JavaScript.
2. Export a callback from the Emscripten module and forward copied RGBA frames to `WebPCGraphicsBridge.presentFrame`. Do not expose a view into memory that QEMU may mutate while the browser is painting.
3. Add guest-side display support (initially a simple 2D framebuffer such as Bochs/VGA or VirtIO-GPU 2D) and boot a tiny Linux graphics test.
4. Forward pointer, touch and keyboard events into a QEMU input device.
5. Only after real guest frames are visible, investigate GLES/OpenGL translation for LWJGL.

## Initial iPad targets

Start at 640×360 and 15 FPS, then measure memory, frame latency and thermal behavior on the actual iPad. Do not raise the VM's 512 MiB RAM limit until a real device test demonstrates headroom. Keep the browser graphics self-test separate: it tests the host WebGL implementation, not guest rendering.
