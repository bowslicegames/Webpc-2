/*
 * WebPC 2 same-origin asset proxy.
 *
 * Browser requests:
 *   /assets/<release filename>
 *
 * The Worker fetches the public GitHub Release asset server-side.
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

    /*
     * Diagnostic endpoint.
     *
     * If /worker-test returns this response, the Cloudflare
     * Pages deployment is definitely executing this _worker.js.
     */
    if (url.pathname === "/worker-test") {
      return new Response(
        "WebPC 2 Worker is ACTIVE\n" +
        "Asset proxy: ACTIVE\n" +
        "Release: V1\n" +
        "QEMU asset: ALLOWED\n",
        {
          status: 200,
          headers: corsHeaders({
            "Content-Type": "text/plain; charset=utf-8",
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

    if (isAssetRequest(url)) {

      const filename =
        decodeURIComponent(
          url.pathname.slice("/assets/".length)
        );

      /*
       * Diagnostic response for unknown filenames. This makes it
       * obvious that the Worker itself handled the request.
       */
      if (!ALLOWED_ASSETS.has(filename)) {
        return new Response(
          "WebPC 2 Worker ACTIVE\n" +
          "Unknown asset: " + filename + "\n",
          {
            status: 404,
            headers: corsHeaders({
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store"
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
            "WebPC 2 Worker ACTIVE\n" +
            "Asset: " + filename + "\n" +
            "GitHub Release request failed: " +
            upstream.status + " " +
            upstream.statusText + "\n" +
            "Upstream URL: " + upstreamURL,
            {
              status: 502,
              headers: corsHeaders({
                "Content-Type":
                  "text/plain; charset=utf-8",
                "Cache-Control": "no-store"
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
          "WebPC 2 Worker ACTIVE\n" +
          "Asset: " + filename + "\n" +
          "Proxy error: " +
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
                "text/plain; charset=utf-8",
              "Cache-Control": "no-store"
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
      "WebPC 2 Worker is ACTIVE, but the static ASSETS binding is not configured.",
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
