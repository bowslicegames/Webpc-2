# Guest display bridge (experimental)

This branch contains a browser-side RGBA framebuffer endpoint:

- `graphics-bridge.js` attaches a 2D canvas and accepts bounded RGBA frames.
- `webpc-gpu.js` is the production presenter: WebGL 2 texture upload and a
  fullscreen triangle, with a compatibility `WebPCGraphicsBridge` facade.
- `presentFrame({width, height, pixels})` copies a guest frame to the canvas.
- `setInputSink(callback)` / `sendInput(event)` provide the host-side input boundary.
- The Minecraft window exposes the display surface and a diagnostics button.
- `tools/test-graphics-bridge.cjs` validates frame dimensions, byte lengths,
  rendering, input forwarding and stop behavior.
- `tools/test-graphics-adapter.cjs` validates the QEMU adapter: ABI detection,
  odd/even frame generations, one reused frame-copy buffer, pacing that does
  not consume a frame, Linux keycode mapping and key release on tab hide.

## Native side

`qemu-webpc-display/webpc-display-abi.c` exposes a bounded RGBA framebuffer with
an odd/even generation counter and a fixed 256-entry input queue.
`qemu-webpc-display/webpc-qemu-hook.c` captures the VGA scanout from
`ui/console.c`, and starts a main-loop timer on machine reset that calls
`graphic_hw_update()` at ~30 Hz and drains the input queue. The pump exists
because the browser build has no host display backend, so QEMU has no display
refresh of its own under `-nographic`.

## Current hard limitation

The **deployed** QEMU runtime predates the frame pump, so the canvas remains
blank and diagnostics report zero frames until the
`Build WebPC QEMU framebuffer runtime` workflow rebuilds the runtime from this
tree and the Worker release pin is updated. The browser side and the native side
are ready for that rebuild; this repository does not claim a visible guest frame
on the current production page.

This is not a virtual GPU and does not translate OpenGL. It is the display
transport boundary needed before guest display integration.

## Required next integration

1. Rebuild the patched QEMU-Wasm runtime so the frame pump and the ABI are in
   the published binary, then verify `webpc-system-x86_64.wasm` exports the
   `webpc_*` symbols.
2. Verify a guest frame reaches the canvas (the VGA console first, then Xorg).
3. Keep guest pointer, touch and keyboard injection validated against the
   guest Xorg/tablet device.
4. Only after real guest frames are visible, investigate GLES/OpenGL
   translation for LWJGL.

## Initial iPad targets

Start at 640×360 and 15–30 FPS, then measure memory, frame latency and thermal
behavior on the actual iPad. Do not raise the VM's guest RAM limit until a real
device test demonstrates headroom. Keep the browser graphics self-test separate:
it tests the host WebGL implementation, not guest rendering.
