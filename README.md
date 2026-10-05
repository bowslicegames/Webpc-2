# Debian i386 Browser VM

A browser-based Debian i386 virtual machine using v86.

The project is designed to run from GitHub Pages.

## Current architecture

The VM uses:

- v86
- WebAssembly
- SeaBIOS
- VGA BIOS
- Debian i386
- browser-based rendering
- iPad-compatible controls

No Node.js server is required for the webpage itself.

## Important 10 GB disk note

The intended virtual disk size is:

10 GiB

However, GitHub Pages is static hosting.

A webpage cannot create a normal writable 10 GB file on the GitHub server.

Therefore a persistent 10 GB disk needs one of these approaches:

1. v86 split disk-image chunks
2. IndexedDB-backed block storage
3. A separate server

The v86 project supports split disk images specifically for static hosting.

The final persistent version should therefore use:

```text
index.html
disk/
    0-1048575.img
    1048576-2097151.img
    ...
