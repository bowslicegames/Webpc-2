# Guest GPU integration attempt — 2026-11-04

## Backup

Before this attempt, main was backed up at:
`backup/pre-guest-gpu-integration-2026-11-04`

## Pinned QEMU-Wasm source

The current runtime lineage is `ktock/qemu-wasm`, pinned for reproducible investigation at:

- Repository: https://github.com/ktock/qemu-wasm
- Commit: `0ef7b4e2814b231705d8371dd7997f5b72e70baf`
- Build instructions: upstream README (Docker image containing Emscripten dependencies)

This is the QEMU-Wasm fork used as the source baseline; it is not proof that the existing V1 release binary was built from this exact revision. Before replacing production assets, compare the current binary/build metadata and reproduce its current build.

## Code committed in this attempt

- The C ABI header now defines a bounded input-event record and dequeue function.
- The C ABI implementation now stores input events in a fixed 256-entry queue, rejects unsupported event types, and counts dropped events rather than silently overwriting old events.
- Framebuffer publication remains bounded to 4096 × 4096 RGBA pixels and increments a generation after copying the complete frame.

## Important integration boundary

This commit is **not a working guest display or GPU driver**. The queue must be drained by a QEMU main-loop callback and translated into QEMU's active keyboard/pointer devices. Likewise, a QEMU `DisplayChangeListener` must call `webpc_publish_frame` with the actual scanout. Neither callback has been wired into QEMU source yet, and the current released `out.js`/Wasm pair does not export this ABI.

The browser-side WebGL2 code can upload and display frames after they arrive. It does not translate guest OpenGL commands.

## OpenGL and LWJGL decision

A direct gl4es-to-WebGL call from the x86 guest is not possible: guest code runs inside the emulated x86 machine and cannot call the browser's JavaScript WebGL context. A real solution needs a guest-to-host graphics protocol/device. Candidate route to investigate is a VirtIO-GPU 3D/virgl-style command transport with a WebAssembly-side renderer that maps supported commands to WebGL2. This needs a QEMU device, guest driver, protocol implementation, shader/resource mapping, synchronization and explicit capability reporting.

LWJGL compatibility then needs a guest-side window/context provider and GLFW-facing implementation (including input, timing, clipboard and possibly audio), with the supported OpenGL version/extensions deliberately constrained to what the WebGL2 backend implements. It cannot be made compatible by adding Java classes alone.

## Required build gates before Minecraft

1. Rebuild the pinned QEMU-Wasm source reproducibly and retain the existing V1 assets as rollback.
2. Wire a QEMU display listener to the framebuffer ABI; export the ABI from Emscripten.
3. Wire the input queue consumer into the QEMU main loop and test key press/release and pointer events.
4. Boot a tiny graphical Linux guest and verify changing pixels and input round trips on the iPad.
5. Implement and test the guest graphics device/protocol plus WebGL2 host renderer with a GLES/OpenGL conformance subset.
6. Provide LWJGL/GLFW compatibility and run a small Java LWJGL triangle before installing Minecraft.
7. Only then add a Minecraft launcher/client, and measure memory/performance on the actual iPad.

No Minecraft files or launcher are added in this attempt because the required guest graphics and LWJGL execution path is not yet present.
