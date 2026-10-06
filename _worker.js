/*
 * WebPC 2 Cloudflare Worker.
 *
 * Normal Wrangler Worker deployment:
 *   wrangler.toml -> main = "_worker.js"
 *
 * The Worker serves the small application files and proxies the large
 * QEMU/Linux release assets from GitHub Releases, keeping every browser
 * request same-origin.
 */

const ALLOWED_ASSETS = new Set([
  "c2w-net-proxy.wasm.gzip",
  "load-initramfs.data",
  "load-initramfs.js",
  "load-kernel.data",
  "load-kernel.js",
  "load-rom.data",
  "load-rom.js",
  "load-rootfs.data",
  "load-rootfs.js",
  "out.js",
  "qemu-system-x86_64.wasm",
  "qemu-system-x86_64.worker.js",
  "stack-worker.js",
  "stack.js"
]);

const STATIC_FILES = new Set([
  "index.html",
  "xterm/xterm.css",
  "xterm/xterm.js",
  "xterm-pty/index.mjs"
]);

const RELEASE_BASE =
  "https://github.com/bowslicegames/Webpc-2/releases/download/V1/";

/*
 * Pin the small application files to a known Git commit.
 *
 * Using /main/ through a CDN can briefly serve an older index.html
 * after a GitHub update. That is particularly confusing for WebPC
 * because the browser can then show an old startup screen while the
 * Worker itself is already new.
 */
const STATIC_COMMIT =
  "d34010ceac9b762a19f6a8768a2c6e8b4d07c7fa";

const RAW_BASE =
  "https://raw.githubusercontent.com/bowslicegames/Webpc-2/" +
  STATIC_COMMIT + "/";

function securityHeaders(extra = {}) {
  return {
    ...extra,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin"
  };
}

function corsHeaders(extra = {}) {
  return securityHeaders({
    ...extra,
    "Access-Control-Allow-Origin": "*"
  });
}

/*
 * These two headers are REQUIRED on the actual document response.
 * The old _headers file does not reliably apply to a normal Wrangler
 * Worker deployment, so set them here as well.
 */
function documentHeaders(extra = {}) {
  return {
    ...extra,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-WebPC-Worker": "active"
  };
}

function isAssetRequest(url) {
  return url.pathname.startsWith("/assets/");
}

function contentType(path) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function errorText(error) {
  return error && error.message
    ? error.message
    : String(error);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /*
     * Explicit diagnostic page.
     */
    if (url.pathname === "/worker-test") {
      return new Response(
        `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WebPC 2 Worker Test</title>
<style>
body{margin:0;padding:32px;background:#080b10;color:#e8edf5;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
main{max-width:700px;margin:auto;background:#10151d;border:1px solid #293341;border-radius:16px;padding:24px}
h1{color:#4ade80}
p{line-height:1.6}
code{background:#1b2330;padding:3px 6px;border-radius:5px}
</style>
</head>
<body>
<main>
<h1>WebPC 2 Worker is ACTIVE</h1>
<p><strong>Cloudflare Worker:</strong> running</p>
<p><strong>Asset proxy:</strong> active</p>
<p><strong>Release:</strong> V1</p>
<p><strong>QEMU asset:</strong> allowed</p>
<p><strong>Cross-origin isolation:</strong> enabled</p>
</main>
</body>
</html>`,
        {
          status: 200,
          headers: documentHeaders({
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store"
          })
        }
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders({
          "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
          "Access-Control-Allow-Headers": "*"
        })
      });
    }

    /*
     * Same-origin proxy for large QEMU/runtime assets.
     */
    if (isAssetRequest(url)) {
      let filename;

      try {
        filename = decodeURIComponent(
          url.pathname.slice("/assets/".length)
        );
      } catch {
        filename = "";
      }

      /*
       * Do not allow path traversal or arbitrary GitHub proxying.
       */
      if (
        !filename ||
        filename.includes("/") ||
        !ALLOWED_ASSETS.has(filename)
      ) {
        return new Response(
          "WebPC 2 Worker ACTIVE\nUnknown asset: " + filename,
          {
            status: 404,
            headers: corsHeaders({
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
              "X-WebPC-Worker": "active"
            })
          }
        );
      }

      const upstreamURL =
        RELEASE_BASE + encodeURIComponent(filename);

      try {
        const upstream = await fetch(upstreamURL, {
          method: request.method === "HEAD" ? "HEAD" : "GET",
          redirect: "follow",
          headers: {
            "Accept": "application/octet-stream"
          }
        });

        if (!upstream.ok) {
          return new Response(
            "WebPC 2 Worker ACTIVE\n" +
            "Asset: " + filename + "\n" +
            "GitHub Release request failed: " +
            upstream.status + " " + upstream.statusText,
            {
              status: 502,
              headers: corsHeaders({
                "Content-Type": "text/plain; charset=utf-8",
                "Cache-Control": "no-store",
                "X-WebPC-Worker": "active"
              })
            }
          );
        }

        const headers = new Headers(upstream.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Cross-Origin-Resource-Policy", "cross-origin");
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        headers.set("Cross-Origin-Embedder-Policy", "require-corp");
        headers.set("X-WebPC-Worker", "active");
        headers.set("X-WebPC-Asset", filename);
        headers.set(
          "Cache-Control",
          "public, max-age=31536000, immutable"
        );

        /*
         * Preserve the upstream Content-Length when GitHub supplies it.
         * The browser can then show accurate download progress.
         */
        if (!headers.has("Content-Type")) {
          headers.set(
            "Content-Type",
            contentType(filename)
          );
        }

        return new Response(upstream.body, {
          status: upstream.status,
          headers
        });
      } catch (error) {
        return new Response(
          "WebPC 2 Worker ACTIVE\n" +
          "Asset: " + filename + "\n" +
          "Proxy error: " + errorText(error),
          {
            status: 502,
            headers: corsHeaders({
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
              "X-WebPC-Worker": "active"
            })
          }
        );
      }
    }

    /*
     * Always route the application files through this Worker first.
     *
     * A Pages ASSETS binding can contain an older index.html. If it
     * wins this route, /worker-test can say ACTIVE while the browser
     * still receives an old page stuck on "checking…".
     */
    let path = url.pathname.replace(/^\/+/, "");

    if (path === "") {
      path = "index.html";
    }

    if (STATIC_FILES.has(path)) {
      try {
        /*
         * index.html comes from the deployed Cloudflare Assets bundle.
         *
         * xterm.js and xterm-pty are deliberately fetched from the
         * pinned GitHub commit below. They are small static files and
         * keeping them on this explicit Worker route avoids differences
         * between Pages/Workers asset-binding behaviour.
         */
        let upstream;

        if (
          path === "xterm/xterm.js" ||
          path === "xterm/xterm.css" ||
          path === "xterm-pty/index.mjs"
        ) {
          upstream = await fetch(
            RAW_BASE + path,
            {
              method:
                request.method === "HEAD"
                  ? "HEAD"
                  : "GET",
              redirect: "follow",
              cf: {
                cacheTtl: 0,
                cacheEverything: false
              }
            }
          );
        } else {
          if (!env.ASSETS) {
            throw new Error(
              "Cloudflare ASSETS binding is missing. " +
              "Check wrangler.toml [assets] configuration."
            );
          }

          const assetRequest = new Request(
            new URL("/" + path, url.origin),
            {
              method: request.method === "HEAD"
                ? "HEAD"
                : "GET",
              headers: request.headers
            }
          );

          upstream =
            await env.ASSETS.fetch(assetRequest);
        }

        if (!upstream.ok) {
          return new Response(
            "WebPC 2 Worker could not load deployed static file: " +
            path +
            " (" +
            upstream.status +
            ")",
            {
              status: 502,
              headers: corsHeaders({
                "Content-Type":
                  "text/plain; charset=utf-8",
                "Cache-Control": "no-store",
                "X-WebPC-Worker": "active"
              })
            }
          );
        }

        const headers =
          new Headers(upstream.headers);

        headers.set(
          "Content-Type",
          contentType(path)
        );

        headers.set(
          "Cache-Control",
          path === "index.html"
            ? "no-store"
            : "public, max-age=3600"
        );

        headers.set(
          "X-WebPC-Worker",
          "active"
        );

        headers.set(
          "X-WebPC-Static-Source",
          "cloudflare-assets"
        );

        if (path === "index.html") {
          headers.set(
            "Cross-Origin-Opener-Policy",
            "same-origin"
          );
          headers.set(
            "Cross-Origin-Embedder-Policy",
            "require-corp"
          );
          headers.set(
            "Cross-Origin-Resource-Policy",
            "same-origin"
          );
        } else {
          headers.set(
            "Cross-Origin-Resource-Policy",
            "same-origin"
          );
        }

        return new Response(
          upstream.body,
          {
            status: upstream.status,
            headers
          }
        );
      } catch (error) {
        return new Response(
          "WebPC 2 Worker static-file error: " +
          errorText(error),
          {
            status: 502,
            headers: corsHeaders({
              "Content-Type":
                "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
              "X-WebPC-Worker": "active"
            })
          }
        );
      }
    }

    return new Response(
      "WebPC 2 Worker ACTIVE\nNo route for: " +
      url.pathname,
      {
        status: 404,
        headers: corsHeaders({
          "Content-Type":
            "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-WebPC-Worker": "active"
        })
      }
    );
  }
};
