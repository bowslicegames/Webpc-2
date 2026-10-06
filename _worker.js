/*
 * WebPC 2 same-origin asset proxy.
 *
 * Browser requests:
 *   /assets/<release filename>
 *
 * The Worker fetches the public GitHub Release asset server-side.
 * GitHub redirects are therefore followed by Cloudflare rather than
 * by the cross-origin-isolated iPad page.
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

const RELEASE_BASE =
  "https://github.com/bowslicegames/Webpc-2/releases/download/V1/";

function corsHeaders(extra = {}) {
  return {
    ...extra,
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": "public, max-age=31536000, immutable"
  };
}

function isAssetRequest(url) {
  return url.pathname.startsWith("/assets/");
}

export default {
  async fetch(request, env, ctx) {

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders({
          "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
          "Access-Control-Allow-Headers": "*"
        })
      });
    }

    if (isAssetRequest(url)) {

      const filename =
        decodeURIComponent(
          url.pathname.slice("/assets/".length)
        );

      if (!ALLOWED_ASSETS.has(filename)) {
        return new Response(
          "Unknown WebPC 2 asset",
          {
            status: 404,
            headers: corsHeaders({
              "Content-Type": "text/plain; charset=utf-8"
            })
          }
        );
      }

      const upstreamURL =
        RELEASE_BASE +
        encodeURIComponent(filename);

      try {

        const upstream =
          await fetch(upstreamURL, {
            method:
              request.method === "HEAD"
                ? "HEAD"
                : "GET",
            redirect: "follow",
            headers: {
              "Accept":
                "application/octet-stream"
            }
          });

        if (!upstream.ok) {

          return new Response(
            "GitHub Release asset request failed: " +
            upstream.status +
            " " +
            upstream.statusText,
            {
              status: 502,
              headers: corsHeaders({
                "Content-Type":
                  "text/plain; charset=utf-8"
              })
            }
          );
        }

        const headers =
          new Headers(upstream.headers);

        headers.set(
          "Access-Control-Allow-Origin",
          "*"
        );

        headers.set(
          "Cross-Origin-Resource-Policy",
          "cross-origin"
        );

        headers.set(
          "Cache-Control",
          "public, max-age=31536000, immutable"
        );

        return new Response(
          upstream.body,
          {
            status: upstream.status,
            headers
          }
        );

      } catch (error) {

        return new Response(
          "WebPC 2 asset proxy error: " +
          (
            error &&
            error.message
              ? error.message
              : String(error)
          ),
          {
            status: 502,
            headers: corsHeaders({
              "Content-Type":
                "text/plain; charset=utf-8"
            })
          }
        );
      }
    }

    /*
     * Everything else is served by the normal Cloudflare
     * static-assets binding.
     */
    if (
      env &&
      env.ASSETS &&
      typeof env.ASSETS.fetch === "function"
    ) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      "WebPC 2 Worker asset proxy is running, but the static ASSETS binding is not configured.",
      {
        status: 500,
        headers: corsHeaders({
          "Content-Type":
            "text/plain; charset=utf-8"
        })
      }
    );
  }
};
