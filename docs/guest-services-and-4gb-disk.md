# WebPC 2: current disk, app-service and display status

## Current disk

- The published guest disk is `disk-rootfs-qcow2.img`, a dynamically allocated qcow2 image with **8 GiB virtual capacity**.
- The image is loaded into QEMU's Emscripten in-memory filesystem at startup.
- Runtime assets may be cached in browser Cache Storage, but that cache is separate from the guest disk.
- Guest filesystem changes are currently **session-local** and are lost when the VM is freshly started.
- The 8 GiB virtual size does not mean an iPad browser can safely allocate 8 GiB of physical memory. The qcow2 image grows as blocks are written, and those writes consume browser-side memory.

The old `tools/expand-rootfs-image.sh` helper is a preparation utility for a standalone ext4 image; it is not the current qcow2 release pipeline.

## Current desktop/service architecture

The visible desktop is an HTML application shell, not a Linux graphical desktop. QEMU currently runs with `-nographic` and exposes the guest through one serial console.

File Manager, Java setup, downloads and other desktop features have separate browser-side queues. These queues prevent ordinary short commands from being submitted simultaneously, but they are **not independent guest runtimes**: all commands still travel through the same serial shell. A stalled shell can block every app.

Closing the Terminal window must not interrupt or reset the guest shell. The browser UI should preserve the same terminal session when the window is reopened.

## Work required for persistent storage

A correct persistence implementation must preserve the *modified* qcow2 disk, not merely cache the original release image.

1. Confirm which persistent browser storage backend is available in the target browsers (IndexedDB, OPFS, or an Emscripten-supported filesystem).
2. Confirm whether the current QEMU-Wasm build includes a compatible persistent filesystem backend. Do not assume IDBFS is present just because Emscripten is used.
3. Avoid copying an entire multi-gigabyte disk into one JavaScript ArrayBuffer. Use bounded, chunked reads/writes and handle browser quota errors.
4. Make startup restore the last complete disk snapshot before QEMU opens it.
5. Make guest writes durable while the VM is running, not only during a graceful page close. iOS may suspend or terminate a tab without firing unload handlers.
6. Use atomic generations/checkpoints so an interrupted write cannot destroy the last good disk.
7. Add explicit storage usage, quota, export, restore and reset controls.
8. Test refresh, tab close, browser termination, low storage, interrupted writes, and restore on iPad Safari and desktop browsers.

Do not label the disk persistent until those tests pass.

## Work required for independent desktop apps

1. Add a guest-side service manager to the Alpine image.
2. Add a dedicated QEMU device/channel for framed app requests, separate from the interactive serial console.
3. Implement request IDs, bounded messages, timeouts, cancellation, and explicit error replies.
4. Restrict file operations to the guest user's home unless an elevated action is explicitly requested.
5. Test simultaneous file listing, reads, writes, downloads, cancellation, and shell responsiveness.
6. Connect each desktop app to that service channel and remove shell-command fallbacks only after the service is proven reliable.

This requires rebuilding and validating the guest image and QEMU runtime together. Browser-side queues alone cannot provide independent guest services.

## Work required for a graphical PC

The current guest is serial-console only. Host WebGL availability does not provide a guest display or GPU.

A graphical environment requires a supported QEMU display device/backend, a Linux guest driver, and a browser-side renderer or display protocol. Only after that exists should a lightweight Linux desktop and graphical applications be added. Minecraft Java's interactive client also needs a working display path and substantially more guest RAM than the current 512 MiB setting.

## Network validation requirements

The network tests must distinguish these layers:

1. The Cloudflare Worker can fetch and stream a large upstream response.
2. `stack.js` can transfer that response through its bounded HTTP bridge.
3. The c2w worker and shared WebSocket ring buffers can move data without loss.
4. The Alpine guest can resolve DNS, complete TLS, and download a known binary.
5. `apk update` and a small package installation complete with verified package signatures.

A Worker-level 40 MiB comparison does not prove steps 2–5. Keep guest-side diagnostics and do not replace the guest disk or package database based only on a successful host-side proxy test.

## Safety rule

Never replace `out.js`, the QEMU WASM binary, the qcow2 image, or the kernel/initramfs release assets unless the corresponding build outputs are available, validated, and recoverable from a known-good release.
