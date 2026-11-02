# WebPC 2 — Linux x86-64 browser VM

WebPC 2 is a browser-based x86-64 Linux virtual machine built around QEMU WebAssembly, xterm.js, xterm-pty and Alpine Linux.

## Current deployment

The production site runs as a **Cloudflare Worker**:

- Worker entrypoint: `_worker.js`
- Wrangler config: `wrangler.toml`
- Worker name: `webpc`
- Large QEMU/Linux assets: GitHub Release `V1`
- Browser-side asset path: `/assets/<filename>`

The Worker proxies release assets through the same origin and supplies the cross-origin-isolation headers required by QEMU-Wasm.

## Cloudflare settings

- **Build command:** `npx wrangler deploy`
- **Root directory:** `/`

Do not switch this project to a static Pages-only deployment. The Worker handles `/assets/*`, the guest HTTP relay, and the cross-origin-isolation headers.

## Important test URLs

After deployment:

- `/worker-test` should display **WebPC 2 Worker is ACTIVE**
- `/assets/qemu-system-x86_64.wasm` should return HTTP 200
- The main page should report:
  - `crossOriginIsolated: true`
  - `SharedArrayBuffer: true`
  - `WebAssembly: true`

## Architecture and current limits

The Worker serves these small files from the repository:

- `index.html`
- `xterm/xterm.css`
- `xterm/xterm.js`
- `xterm-pty/index.mjs`
- The pinned ES-module `stack.js`

The Worker serves the QEMU runtime and Linux assets from Release `V1`, including the 8 GiB virtual qcow2 disk image.

The guest disk is currently loaded into Emscripten's in-memory filesystem. **The 8 GiB figure is virtual capacity, not a guarantee that the browser can allocate 8 GiB of RAM. Guest file changes are lost when the VM is freshly started.** Cache Storage keeps downloaded runtime assets between visits where the browser allows it; asset byte sizes are checked before caching, and every disk release rotates the cache version so old base images are not silently reused. That cache does not persist the guest disk.

The desktop is currently a browser-based HTML shell around a serial-console Linux guest. QEMU is started with `-nographic`; there is no guest graphical display or accelerated guest GPU yet. The host browser's WebGL support is not a guest GPU. Consequently, graphical Linux applications and the Minecraft Java client cannot yet be displayed inside WebPC.

File Manager, Java setup, downloads and other desktop services use separate browser-side queues, but their short control commands still share the guest's one serial shell. A genuinely independent app/service channel requires a guest-side service and a matching QEMU device/channel.

Guest internet traffic follows this route:

```text
Alpine guest → c2w-net-proxy → stack.js → same-origin /net-proxy → Cloudflare Worker → internet
```

The Worker streams responses with bounded buffering, revalidates every HTTP redirect against its host allowlist, and rejects HTML error pages when a binary download was requested. The guest relay is an allowlisted HTTP(S) proxy, not an unrestricted raw-IP/ICMP internet connection. This prevents an HTML error page from silently being saved as a `.wasm` or package file. A successful Worker-level download test does not by itself prove that the complete guest networking path works on every browser/device.

## Cross-origin isolation

The Worker explicitly sends:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Release assets are served with:

```text
Cross-Origin-Resource-Policy: cross-origin
Access-Control-Allow-Origin: *
```

The HTML document needs cross-origin isolation for SharedArrayBuffer, while proxied binary resources must remain embeddable by the isolated page.

## QEMU module loading

The generated Emscripten `out.js` is imported from its same-origin Worker URL rather than a `blob:` URL. This keeps pthread/worker resource paths anchored to the actual `/assets/` endpoint.

## Automated validation

GitHub Actions now checks:

1. Worker and network bridge JavaScript syntax.
2. The bounded 40 MiB HTTP streaming regression test.
3. WebSocket ring-buffer lock contention and wrap-around.
4. Every inline browser script, DOM ID reference, and browser-global reference (ESLint `no-undef`).
5. Runtime size-manifest accuracy and equality between the Worker-pinned `stack.js` and the tested source.
6. The local xterm-pty module syntax and Wrangler configuration.
7. The live Worker revision, binary error handling, 40 MiB direct/proxy byte equality, and the published qcow2 guest boot (in their respective workflows).

These tests do not emulate iPad Safari or prove the guest's full real-world network/package-manager path. Final testing on the target browser/device remains necessary.

## Release assets

The large runtime binaries are kept in GitHub Release `V1` because committing the QEMU/Linux binaries directly to the repository is unsuitable. The checked-in Worker and HTML must remain in sync with the exact release asset names and sizes.
