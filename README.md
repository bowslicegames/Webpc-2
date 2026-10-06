# WebPC 2 — Linux x86-64 browser VM

WebPC 2 is a browser-based x86-64 Linux virtual machine using QEMU WebAssembly, xterm.js, xterm-pty and an Alpine Linux x86-64 runtime.

## Current deployment

The production site is intended to run as a **Cloudflare Worker**:

- Worker entrypoint: `_worker.js`
- Wrangler config: `wrangler.toml`
- Worker name: `webpc`
- Large QEMU/Linux assets: GitHub Release `V1`
- Browser-side asset path: `/assets/<filename>`
- No persistent browser storage is used by the VM.

The Worker proxies release assets through the same origin so the browser does not have to fetch the large QEMU files directly from GitHub.

## Cloudflare settings

Because this repository uses Wrangler Worker deployment, use:

- **Build command:** `npx wrangler deploy`
- **Root directory:** `/`

Do not switch this project to a static Pages-only deployment. The Worker is responsible for the `/assets/*` proxy and for sending the cross-origin-isolation headers required by QEMU-Wasm.

## Important test URLs

After deployment:

- `/worker-test` should display **WebPC 2 Worker is ACTIVE**
- `/assets/qemu-system-x86_64.wasm` should return HTTP 200
- The main page should report:
  - `crossOriginIsolated: true`
  - `SharedArrayBuffer: true`
  - `WebAssembly: true`

If `/worker-test` is blank or the QEMU asset returns a plain 404, the deployed Worker is not the Worker from this repository.

## Architecture

The Worker serves these small files from the repository:

- `index.html`
- `xterm/xterm.css`
- `xterm/xterm.js`
- `xterm-pty/index.mjs`

It proxies the following release assets:

- `qemu-system-x86_64.wasm`
- `qemu-system-x86_64.worker.js`
- `out.js`
- `stack.js`
- `stack-worker.js`
- QEMU ROM/kernel/initramfs/rootfs data and loader files
- `c2w-net-proxy.wasm.gzip`

The browser downloads these into memory at startup. The project does not intentionally persist the VM disk or user login data.

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

This is deliberate: the HTML document needs cross-origin isolation for SharedArrayBuffer, while the proxied binary resources must remain embeddable by the isolated page.

The repository also contains `_headers` for deployments that process that file, but the Worker sets the critical headers itself because Worker-generated responses are not covered by `_headers`.

## QEMU module loading

The generated Emscripten `out.js` is imported from the same-origin Worker URL rather than a `blob:` URL. This avoids a common pthread/worker failure where relative worker files are resolved against a Blob URL instead of the actual `/assets/` path.

## Automated validation

GitHub Actions checks:

1. `_worker.js` JavaScript syntax.
2. The inline JavaScript module inside `index.html`.
3. The required Wrangler configuration.

This does not emulate an iPad or execute QEMU; final browser testing still needs a real browser/device.

## Release

The runtime binaries are kept in GitHub Release `V1` because Cloudflare's individual static-asset limits make committing the large QEMU/Linux binaries directly to the repository unsuitable.

