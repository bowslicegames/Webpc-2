# Minecraft performance work (512 MiB guest)

## Current tuning change

The browser QEMU command line keeps guest RAM at 512 MiB and uses single-threaded TCG, with its translated-block (TB) cache bounded to 128 MiB instead of 500 MiB. A very large TB cache competes with the WebAssembly runtime and browser for host memory. The smaller cache is a memory-pressure experiment; depending on workload it may cause more TB flushes, so measure it on the target iPad rather than assuming it improves FPS.

MTTCG is deliberately not enabled. The current WebKit/iPad runtime is built around a constrained Emscripten worker setup; enabling multiple TCG threads without confirming pthread and SharedArrayBuffer support throughout QEMU risks startup regressions.

## What is still missing before Minecraft can render

- The checked-in QEMU runtime does not export the WebPC framebuffer ABI. The browser canvas is only a receiver and cannot display guest frames yet.
- The C ABI starter is not wired into QEMU's display callbacks.
- The VM still has no working guest OpenGL/GLES implementation translated to WebGL 2.
- LWJGL's window/context, input and audio interfaces are not implemented.
- There is not yet an end-to-end Minecraft launcher/profile in the guest.

Consequently this commit does not claim Minecraft is playable or that 30–60 FPS is currently achievable. A passing browser WebGL self-test only proves the iPad browser can render its own WebGL content.

## Memory policy

Keep QEMU guest RAM at 512 MiB. Do not treat swap as extra fast RAM: ZRAM can reduce out-of-memory failures but costs CPU time and memory bandwidth, and is not an FPS accelerator. Keep Minecraft heap conservative once a working display path exists (initial experiment: `-Xms128M -Xmx256M`, then measure; lower if Alpine plus the graphics stack needs more headroom). Avoid allocating most guest RAM to Java.

## Performance milestones and measurements

1. Verify QEMU boots reliably with the 128 MiB TB cache and record browser tab memory / stability.
2. Integrate the QEMU framebuffer callback and show a Linux text/desktop frame at 640x360.
3. Measure frame-copy cost and latency at 10, 15 and 30 FPS; avoid full-frame copies when no guest frame changed.
4. Implement a GLES/OpenGL compatibility route to WebGL 2 and validate an LWJGL test application before Minecraft.
5. Add Minecraft performance settings: 4–6 chunk render distance initially, simulation distance 4, clouds off, particles minimal, entity distance low, biome blend 0, mipmaps 0, and a low internal resolution. These settings reduce rendering load but cannot compensate for missing guest GPU acceleration.
6. Run a real multiplayer server test and record average FPS, 1% lows, CPU time, memory use, frame latency and thermal throttling on the iPad.

A 30 FPS target should be evaluated first. 60 FPS is a stretch goal and may not be realistic with full x86 QEMU TCG emulation on an iPad browser.