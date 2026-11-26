# Headless guest harness

`tools/webpc-vm.mjs` boots the **production** QEMU-runtime, kernel, initramfs and
guest disk under Node, so launcher changes can be tested without an iPad and
without a human at the keyboard. `tools/webpc-minecraft-test.mjs` drives it.

## Why it is not just a browser test

The browser path is covered by `tests/webpc-boot-test.mjs`, but that stops at the
login prompt and cannot type into the guest. The harness runs the same runtime
outside a browser so the serial console is a socket the agent can read and write.

## Setup

```sh
node tools/webpc-vm.mjs prep      # downloads the live release assets once
node tools/webpc-vm.mjs run       # boots; prints the control port
```

`prep` mirrors what `_worker.js` serves: `out.js`, `qemu-system-x86_64.wasm` and
`qemu-system-x86_64.worker.js` from the pinned QEMU release tag, and the kernel,
initramfs, firmware and qcow2 disk from the `V1` release. Everything lands in
`.harness/` (gitignored). The disk is copied once from `disk-rootfs-qcow2.img` to
`.harness/disk/webpc-disk.qcow2`, which becomes the guest's persistent disk, the
same role OPFS plays in Safari. Delete that file for a clean first boot.

## Driving it

```sh
node tools/webpc-vm.mjs ctl status              # serial byte count + frame generation
node tools/webpc-vm.mjs ctl tail 4000          # recent serial output
node tools/webpc-vm.mjs ctl send "root\r"      # type into the guest console
node tools/webpc-vm.mjs ctl shot artifacts/g.png
node tools/webpc-vm.mjs ctl quit
```

`shot` reads QEMU's VGA scanout through the `webpc_get_framebuffer_*` exports and
writes a PNG, so the guest's actual screen can be inspected rather than inferred
from logs.

`webpc-minecraft-test.mjs --launch` writes `tools/webpc-minecraft-display.sh`
into the guest exactly the way `index.html` does (base64 chunks into a temp file,
then `nohup`), and `--expect <regex>` waits for a marker such as
`painted the X root window`. `--shot` captures the result.

## Guest login

The published disk asks for the root password on `ttyS0`; the page never embeds
it. For unattended runs, append a passwordless console instead of storing one:

```sh
node tools/webpc-vm.mjs run --append="rdinit=/bin/sh"
```

That lands in the initramfs busybox shell (`~ #`) in about three minutes here.
The initramfs has no applet symlinks, so call `/bin/busybox <applet>`, then load
`virtio_pci`/`virtio_blk` before mounting `/dev/vda`. `--append=init=/bin/sh`
skips login but still pays for the initramfs root mount.

## Two differences from the browser, both test-only

1. `navigator.storage` is replaced by a shim inside the QEMU pthread worker that
   performs the same synchronous random-access I/O on the host disk file. The
   guest still boots `-drive file=webpc-opfs:webpc-disk.qcow2`, so the WebPC OPFS
   block driver is under test; only its backing store differs.
2. The serial console is a TCP control socket instead of xterm.

## The PTY parking failure (found with this harness)

QEMU's main loop polls the console. With an empty PTY it parks there, and under
Node that park blocks the thread that also runs TCG, so emulated time stops:

- without `noapic` the guest panics during timer bring-up with
  `IO-APIC + timer doesn't work!`;
- with `noapic` it boots to the last `fs_initcall`, prints nothing further, and
  spins; console input is still echoed by the tty layer, which makes it look
  alive.

Both symptoms disappear when the PTY fires a readable event every 25 ms. The
keepalive lives in the harness shim, not in the guest or the page.

## Known limit in this sandbox

Guest block I/O through the emulated qcow2 rounds trip to JavaScript, and on the
2-core sandbox each 4 KiB request costs roughly 23 ms (`info blockstats`). The
read-only root mount alone takes about five minutes, which makes a full
OpenRC + Xorg + Prism boot hours rather than minutes here. That is a property of
this environment, not of the iPad, where the same runtime reaches Xorg and Prism
in minutes. Plan harness runs accordingly: watch `info blockstats`, and expect a
first boot that must be left running rather than a two-minute smoke test.
