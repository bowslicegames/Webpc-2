# WebPC GPU display application

`webpc-gpu.js` is the browser-side GPU display application. It creates a WebGL 2 context, compiles a GLSL ES 3.00 fullscreen-triangle program, uploads guest RGBA frames into a GPU texture, and draws that texture to the WebPC display canvas. It exposes `window.WebPCGPU` and a compatibility `window.WebPCGraphicsBridge` facade for the existing QEMU frame adapter.

## Features

- WebGL 2 shader compilation and program linking.
- Texture allocation on guest resolution changes and `texSubImage2D` for subsequent frames.
- GPU texture sampling and fullscreen-triangle presentation.
- 30 FPS default upload/presentation cap, adjustable from 1 to 60 with `WebPCGPU.setFrameCap(fps)`.
- Display diagnostics through `WebPCGPU.getStats()`.
- Existing pointer/key input bridge facade.
- No silent 2D-canvas fallback: WebGL 2 failure is reported explicitly.

## Current integration boundary

This application accelerates presentation of guest framebuffer pixels using the iPad/browser GPU. It does not translate guest OpenGL calls into WebGL and it does not create a virtual GPU device for Linux. The current QEMU-Wasm runtime still needs the native WebPC framebuffer ABI and real QEMU input injection. The C ABI starter is not yet linked to QEMU's display or input backends, so no Linux or Minecraft frames can be produced by this application alone.

To provide actual Minecraft GPU acceleration, the next backend must implement a guest graphics device/protocol (for example virtio-gpu with a Mesa-compatible renderer or a purpose-built GLES command stream), translate its commands to WebGL 2, and provide LWJGL-compatible context/window/input semantics. Simply copying a framebuffer is display acceleration, not guest 3D acceleration.

## Browser API

- `WebPCGPU.attach(canvas)` initializes the WebGL 2 renderer.
- `WebPCGPU.presentFrame({width,height,pixels})` uploads and presents one RGBA frame.
- `WebPCGPU.setFrameCap(30)` caps presentation to 30 frames per second.
- `WebPCGPU.setInputSink(fn)` and `WebPCGPU.sendInput(event)` forward input to the connected guest adapter.
- `WebPCGPU.getStats()` reports renderer, resolution, frame count, FPS window, cap and context status.

The validation workflow syntax-checks the application and verifies its WebGL upload/draw path is present. Hardware performance and guest-frame delivery still require testing on the target iPad with a QEMU build that implements the ABI.