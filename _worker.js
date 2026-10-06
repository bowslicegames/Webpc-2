/*
 * WebPC 2 Cloudflare Worker.
 *
 * This version works both with a Pages ASSETS binding and as a normal
 * Worker deployment. Release assets are always proxied same-origin.
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

const RAW_BASE =
  "https://raw.githubusercontent.com/bowslicegames/Webpc-2/main/";

function corsHeaders(extra = {}) {
  return {
    ...extra,
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin"
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

export default {
  async fetch(request, env, ctx) {

    const url = new URL(request.url);

    /*
     * Large, visible diagnostic page.
     * This deliberately uses HTML so it is obvious in Safari/Chrome.
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
<p><strong>Deployment commit:</strong> cdd303c0cb6de1d85262117a6412ee152b842c3e or newer</p>
</main>
</body>
</html>`,
        {
          status: 200,
          headers: corsHeaders({
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-WebPC-Worker": "active"
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
     * Same-origin proxy for the large QEMU/runtime assets.
     */
    if (isAssetRequest(url)) {

      const filename =
        decodeURIComponent(
          url.pathname.slice("/assets/".length)
        );

      if (!ALLOWED_ASSETS.has(filename)) {
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
        headers.set("X-WebPC-Worker", "active");
        headers.set("X-WebPC-Asset", filename);
        headers.set(
          "Cache-Control",
          "public, max-age=31536000, immutable"
        );

        return new Response(upstream.body, {
          status: upstream.status,
          headers
        });

      } catch (error) {
        return new Response(
          "WebPC 2 Worker ACTIVE\n" +
          "Asset: " + filename + "\n" +
          "Proxy error: " +
          (error && error.message ? error.message : String(error)),
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
     * If a Pages ASSETS binding exists, use it first.
     */
    if (
      env &&
      env.ASSETS &&
      typeof env.ASSETS.fetch === "function"
    ) {
      const assetResponse = await env.ASSETS.fetch(request);

      if (assetResponse.status !== 404) {
        return assetResponse;
      }
    }

    /*
     * Fallback for a normal workers.dev Worker without an ASSETS
     * binding. This keeps the small application files same-origin too.
     */
    let path = url.pathname.replace(/^\/+/, "");

    if (path === "") {
      path = "index.html";
    }

    if (STATIC_FILES.has(path)) {
      try {
        const upstream = await fetch(RAW_BASE + path, {
          method: request.method === "HEAD" ? "HEAD" : "GET",
          redirect: "follow"
        });

        if (!upstream.ok) {
          return new Response(
            "WebPC 2 Worker could not load static file: " +
            path + " (" + upstream.status + ")",
            {
              status: 502,
              headers: corsHeaders({
                "Content-Type": "text/plain; charset=utf-8",
                "X-WebPC-Worker": "active"
              })
            }
          );
        }

        const headers = new Headers(upstream.headers);
        headers.set("Content-Type", contentType(path));
        headers.set("Cross-Origin-Resource-Policy", "same-origin");
        headers.set("Cache-Control", "no-cache");
        headers.set("X-WebPC-Worker", "active");

        return new Response(upstream.body, {
          status: upstream.status,
          headers
        });

      } catch (error) {
        return new Response(
          "WebPC 2 Worker static-file proxy error: " +
          (error && error.message ? error.message : String(error)),
          {
            status: 502,
            headers: corsHeaders({
              "Content-Type": "text/plain; charset=utf-8",
              "X-WebPC-Worker": "active"
            })
          }
        );
      }
    }

    return new Response(
      "WebPC 2 Worker ACTIVE\nNo route for: " + url.pathname,
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
};
