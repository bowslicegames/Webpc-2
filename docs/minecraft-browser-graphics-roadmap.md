# Minecraft browser graphics roadmap

## Experimental branch

This work is isolated on `experimental/minecraft-browser-graphics`. It is not the production VM and does not replace the current `main` release.

## Stage 1: browser GPU validation (implemented)

The Virtual Computer app now includes a WebGL 2 self-test. It compiles GLSL ES 3.00 vertex/fragment shaders, draws a triangle, and reads a pixel back from the framebuffer. The test is deliberately run only after the user presses the button, so it does not create or retain a GPU context during normal VM startup.

A passing result proves that the current browser tab can create a WebGL 2 context and execute a small GPU render/readback. It does **not** prove that QEMU can display a guest framebuffer, that OpenGL calls from Linux are translated, or that Minecraft can run.

## Stage 2: real 2D guest display

Current QEMU launch arguments use `-nographic`, and the checked-in browser runtime is a prebuilt Emscripten QEMU binary. There is no display device or browser frame callback in the current runtime. The guest kernel must expose `CONFIG_DRM_VIRTIO_GPU` (or a deliberately chosen simpler framebuffer device), and the QEMU build must include a browser-compatible display output backend.

The first implementation should use a 2D VirtIO-GPU framebuffer and copy changed frames into a browser-owned canvas using bounded frame buffers. It should support resize, pause/stop, context loss, and a low frame-rate/low-resolution mode for iPad. It must not put guest frames through xterm or the serial command broker.

Acceptance tests:
- QEMU starts with the display device and existing serial console still works.
- Alpine detects the guest display device and exposes a framebuffer/DRM node.
- A guest test pattern appears on the browser canvas.
- Touch resize and orientation changes do not hang the VM.
- Repeated frame delivery is bounded and does not grow memory without limit.

## Stage 3: OpenGL ES / WebGL translation

A 2D display is not a 3D accelerator. For Minecraft, build a compatibility layer that maps the subset of desktop OpenGL used by the chosen Minecraft/LWJGL version to OpenGL ES 3 / WebGL 2. A possible route is Mesa plus a GLES compatibility translator such as gl4es, compiled for the guest/runtime combination. VirGL is not a drop-in solution: the QEMU host-side virglrenderer and its graphics API integration must also be built for the browser environment.

Do not advertise 3D acceleration until a guest GL conformance/sample program renders correctly through the browser backend.

## Stage 4: Java and game runtime

- Java 21 runtime, verified with a real JVM smoke test.
- LWJGL window/context, OpenGL calls, keyboard, pointer lock/touch, controller and audio compatibility.
- Browser-safe networking for authentication/session and multiplayer; preserve origin and credential security.
- Persistent guest disk or a carefully designed persistent game-data volume; the current guest disk resets on a fresh launch.
- Chunked downloads and bounded cache storage; expose free space and storage quota.
- Adjustable resolution, render distance, frame cap, memory allocation and performance presets.

## iPad constraints

iPadOS browser tabs are memory- and power-constrained. A large dynamically growing virtual disk is not equivalent to free RAM. Do not increase guest RAM or allocate multiple full-size frame buffers without measuring peak memory on a real iPad. Start with a small display (for example 640x360), 15–30 FPS, and a low Minecraft render distance; offer higher settings only after sustained tests. WebGL 2 availability is tested in the actual tab because browser/GPU policy can differ by device and session.

## Current status

Only Stage 1 has been implemented in this branch. No QEMU binary, guest kernel, Java runtime, or production asset has been changed. Minecraft Java is not yet playable in WebPC.
