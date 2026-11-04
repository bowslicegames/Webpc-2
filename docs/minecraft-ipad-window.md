# iPad Minecraft window and graphics status

The Minecraft desktop window now has an iPad-oriented control shell:
- Fullscreen button for the game display area.
- Touch D-pad for W/A/S/D movement.
- Jump, sneak, inventory, drop, pause and swap buttons.
- Separate look pad that emits relative-look-style pointer events.
- Attack and place buttons.
- QEMU framebuffer polling interval capped at 30 Hz.

## Important current limitation

This is the browser-side presentation and input shell, not a functioning Minecraft display yet. The checked-in QEMU runtime still does not export the WebPC framebuffer ABI, so the canvas will remain blank until QEMU is rebuilt with the native display backend. The current C ABI starter's input function records input values but does not enqueue them into QEMU input devices. The browser touch controls therefore cannot control a guest game until that native input path is completed.

Likewise, polling at 30 Hz is not the same as rendering Minecraft at 30 FPS. A real guest GPU path is still required: QEMU display integration, guest GPU device/driver, Mesa/OpenGL ES compatibility and an LWJGL-compatible context routed to WebGL 2. The host WebGL self-test proves only that the browser can render its own WebGL content.

Do not advertise this build as playable or GPU-accelerated Minecraft. The next required engineering milestone is rebuilding the exact QEMU-Wasm runtime with framebuffer and input integration, then proving a Linux guest frame reaches the canvas. After that, validate OpenGL ES with a small native guest test before launching Minecraft.