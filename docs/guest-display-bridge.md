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


## QEMU adapter and native ABI starter

The branch now also contains:

- `graphics-qemu-adapter.js`: polls a defined Emscripten ABI at 15 FPS, copies guest RGBA pixels out of Wasm memory before presenting, and forwards canvas pointer/keyboard events.
- `qemu-webpc-display/webpc-display-abi.h`: ABI declarations.
- `qemu-webpc-display/webpc-display-abi.c`: bounded framebuffer storage and exported getter/input functions. This is an integration starter, not yet called by QEMU's display code.
- The VM arguments explicitly request `-vga std` and add `console=tty0` while retaining the serial console. This requests a guest VGA device, but `-nographic` still means there is no host display output.

### Required QEMU build wiring

The current repo does not include the QEMU source tree or a rebuilt QEMU binary. To make the ABI live, the QEMU-Wasm build must:

1. Compile `webpc-display-abi.c` into the QEMU module.
2. Export `_webpc_get_framebuffer_ptr`, `_webpc_get_framebuffer_width`, `_webpc_get_framebuffer_height`, `_webpc_get_framebuffer_generation`, and `_webpc_send_input` from Emscripten.
3. Register a QEMU display backend. Its scanout callback must convert/copy guest scanout pixels to RGBA8888 and call `webpc_publish_frame()` after each completed frame.
4. Queue input events from `webpc_send_input()` and inject them into QEMU's active keyboard/pointer devices on the QEMU main loop. The starter currently records input only; it does not inject it.
5. Build with a display device/driver combination supported by the selected QEMU machine and Alpine kernel. The present `-vga std` setting is a first guest-side device attempt, not proof of a working scanout backend.

### OpenGL / Minecraft path

The framebuffer route is a 2D display path. Minecraft Java needs an OpenGL implementation for LWJGL. The next graphics milestone is to port or embed a GLES implementation (candidate investigation: gl4es) that renders through WebGL 2, and then provide the required GLFW/window/input/audio behavior expected by the target Minecraft version. A 2D VGA framebuffer alone will not provide hardware-accelerated Minecraft rendering.

No Java, LWJGL, OpenGL translation or Minecraft launch claim should be considered complete until the guest desktop and an actual game frame are visible in the canvas.
