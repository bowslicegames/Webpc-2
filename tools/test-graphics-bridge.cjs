const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const canvas = {
  width: 1, height: 1,
  getContext(kind) {
    assert.equal(kind, "2d");
    return { putImageData(image, x, y) { this.image = image; this.x = x; this.y = y; } };
  }
};
class FakeImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
}
const window = {};
const sandbox = {
  window, HTMLCanvasElement: class HTMLCanvasElement {},
  ImageData: FakeImageData, Uint8Array, Uint8ClampedArray,
  performance: { now: () => 123.5 }
};
Object.setPrototypeOf(canvas, sandbox.HTMLCanvasElement.prototype);
vm.runInNewContext(fs.readFileSync("graphics-bridge.js", "utf8"), sandbox);
const bridge = window.WebPCGraphicsBridge;
assert.ok(bridge);
bridge.attach(canvas);
assert.equal(bridge.getStats().attached, true);
const pixels = new Uint8Array(2 * 2 * 4).fill(127);
assert.equal(bridge.presentFrame({ width: 2, height: 2, pixels }), true);
assert.equal(canvas.width, 2);
assert.equal(canvas.height, 2);
assert.equal(bridge.getStats().frames, 1);
assert.throws(() => bridge.presentFrame({ width: 0, height: 2, pixels }), /dimensions/);
assert.throws(() => bridge.presentFrame({ width: 2, height: 2, pixels: new Uint8Array(3) }), /RGBA/);
let received = null;
bridge.setInputSink(event => { received = event; });
assert.equal(bridge.sendInput({ type: "key", code: "KeyW" }), true);
assert.equal(received.code, "KeyW");
bridge.stop();
assert.equal(bridge.presentFrame({ width: 2, height: 2, pixels }), false);
assert.equal(bridge.sendInput({ type: "key" }), false);
console.log("Graphics bridge tests passed.");
