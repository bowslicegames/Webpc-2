const fs = require("fs");
const source = fs.readFileSync("webpc-gpu.js", "utf8");
for (const marker of [
  'getContext("webgl2"',
  'gl.texImage2D',
  'gl.texSubImage2D',
  'gl.drawArrays',
  'setFrameCap',
  'maxFps:30',
  'window.WebPCGPU',
  'window.WebPCGraphicsBridge'
]) {
  if (!source.includes(marker)) throw new Error("WebPC GPU feature missing: " + marker);
}
if (source.includes('getContext("2d"')) {
  throw new Error("GPU display must not silently fall back to a 2D canvas");
}
console.log("WebPC GPU application checks passed.");
