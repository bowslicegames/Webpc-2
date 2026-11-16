# iPad Minecraft window and graphics status

The Minecraft desktop window has an iPad-oriented control shell:

- Fullscreen button with an in-page fullscreen layout fallback, because iPad
  Safari does not allow `requestFullscreen()` on arbitrary elements.
- Touch D-pad for W/A/S/D movement with press-and-hold key state.
- Jump, sneak, sprint, inventory, chat, drop, pause, swap, alternate-view
  (F5) and debug (F3) buttons.
- Larger 44 px+ touch targets, a landscape layout and `touch-action: none`.
- Separate look pad that emits relative-look-style pointer events at a fixed
  sensitivity. Dragging directly on the game view also aims, because the
  absolute touch position is forwarded to the guest tablet device.
- Attack and place buttons, hotbar slot buttons 1–9.
- Held keys are released when the tab is hidden or the page loses focus, so
  movement cannot stick after switching apps on iPad.
- Display presentation is capped at 30 FPS, with a 20 FPS toggle for iPad
  battery/thermal headroom.
- The status line reports live resolution, frame rate and total guest frames
  copied once frames start arriving.

## Frame transport

`graphics-qemu-adapter.js` polls the QEMU framebuffer ABI at 30 Hz, copies each
completed frame out of WebAssembly memory into one reused buffer, and presents
it through `webpc-gpu.js` (WebGL 2 texture upload + fullscreen triangle). The
WebGL presenter is attached once and reused, survives context loss/restore,
and keeps the display area's aspect ratio in sync with the guest mode. Polling
stops while the tab is hidden.

`qemu-webpc-display/webpc-qemu-hook.c` now starts a QEMU main-loop frame pump
on machine reset. The pump calls `graphic_hw_update()` on the VGA console at
~30 Hz, which is required because the browser build has no host display backend
and therefore no display-refresh timer of its own. It also drains the browser
input queue on every tick, so keyboard/pointer events are delivered even when
the guest has not produced a frame yet.

## Guest X driver probe

The runtime launcher probes `/dev/dri/card0`, then `/dev/fb0`, and starts Xorg
with `modesetting`, `fbdev` or `vesa` in that order, retrying the next driver if
Xorg exits before creating the `:0` socket. `xf86-video-vesa` and
`xf86-video-fbdev` are installed with the rest of the Minecraft runtime. The
selected driver and the detected devices are appended to
`/var/log/webpc-xorg.log`.

If the display ABI connects but no frame arrives within 20 seconds, the display
status now says so explicitly and points at a runtime that predates the frame
pump, instead of silently showing an empty canvas.

## Important current limitation

The deployed release runtime was built before this pump existed, so on the
current production page the canvas stays blank and diagnostics report zero
frames. Publishing the pump requires the `Build WebPC QEMU framebuffer runtime`
workflow to rebuild and republish the QEMU-Wasm runtime, after which the Worker
release pin must be updated. The browser side and the native side are ready for
that rebuild; no frame is claimed to be visible before it happens.

Polling at 30 Hz is not the same as rendering Minecraft at 30 FPS. The frame
pump transports guest scanout; it does not translate guest OpenGL. Minecraft
Java still needs a guest GL implementation (Mesa llvmpipe inside the guest is
the current attempt) plus a working Xorg mode on the guest VGA device. The host
WebGL self-test proves only that the browser can render its own WebGL content.

Do not advertise this build as playable until a guest Xorg/Prism frame has been
observed on the canvas on the target iPad.
