# WebPC 2: guest services and 4 GiB disk rollout

## Current safe state

The deployed architecture still loads the root disk from the Emscripten preload bundle (load-rootfs.data + load-rootfs.js) into the browser's in-memory filesystem. The QEMU -m 512M option is RAM, not disk capacity. The browser File Manager still issues filesystem operations through the shared guest serial shell.

A genuine service split and a real 4 GiB disk are not activated by adding front-end JavaScript alone. This document records the implementation path so that the running VM is not broken by a pretend fix.

## Service split plan

1. Add a guest-side service manager to the Alpine image and start it from the guest's boot sequence.
2. Provide a dedicated QEMU device/channel for the service protocol; do not route file listing, file reads/writes, downloads, or app jobs through the interactive shell.
3. Use framed requests with request IDs, bounded message sizes, timeouts, cancellation, and explicit error replies. File operations must be rooted in the guest user's home unless the user explicitly requests an elevated operation.
4. Keep the interactive terminal on its current console channel. Give File Manager and other apps separate logical RPC clients and queues over the dedicated service channel.
5. Test concurrent listing/read/write requests, interrupted transfers, path traversal rejection, binary files, cancellation, and shell responsiveness.
6. Only then wire the browser apps to the RPC client and remove their terminal-command fallbacks.

Integration blocker: the guest boot filesystem/initramfs and QEMU-generated release bundle are not tracked in this repository. The current browser runtime exposes only the console path to app code; no guest daemon or independent service channel is present. The service cannot be made active until the guest image and QEMU runtime are rebuilt together.

## 4 GiB disk plan

1. Obtain the exact source disk image from the build pipeline (not the Emscripten preload .data bundle).
2. Inspect whether it is a whole-device ext4 image or a partitioned disk. Do not assume the layout.
3. Use tools/expand-rootfs-image.sh SOURCE.img OUTPUT.img only for a standalone ext4 filesystem image. It makes a sparse 4 GiB copy and checks the filesystem before and after resizing. It deliberately refuses unknown or partitioned layouts.
4. Repackage the new image into the matching Emscripten preload data/loader assets, preserving paths and generated metadata.
5. Fix the runtime's storage backend so a 4 GiB virtual image does not require a dense 4 GiB JavaScript heap allocation. A sparse file on the host build machine alone does not guarantee sparse storage in browser MEMFS.
6. Update the exact release assets and known-size metadata together; test asset hashes/HTTP status, fresh cache loading, boot, df -h, filesystem writes across the 512 MiB boundary, and a reboot.
7. Deploy only after a real browser test confirms disk capacity and memory use.

## Release limitation

The GitHub integration available for this repository can update tracked text files but does not expose GitHub Release asset upload/replacement. The release assets are generated binaries and are not tracked source files. Changing the QEMU drive arguments or only changing the HTML's reported capacity would not expand the actual guest disk.

## Safety rule

Never replace out.js, load-rootfs.data, load-rootfs.js, or the disk image in production unless the corresponding generated assets are available, validated, and can be restored from the backup release.
