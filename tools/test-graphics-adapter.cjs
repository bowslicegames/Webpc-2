const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

let now = 1000;
let allocations = 0;
class TrackedUint8Array extends Uint8Array {
  constructor(length) { super(length); allocations++; }
}

const listeners = new Map();
const canvasListeners = new Map();
const canvas = {
  width: 640, height: 360, style: {}, tabIndex: -1,
  addEventListener(type, fn) {
    if (!canvasListeners.has(type)) canvasListeners.set(type, new Set());
    canvasListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { canvasListeners.get(type)?.delete(fn); },
  getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 360 }; },
  focus() {},
  setPointerCapture() {}
};

const presented = [];
let presentResult = true;
let attachCalls = 0;
const bridge = {
  attach() { attachCalls++; return {}; },
  presentFrame(frame) {
    presented.push({ width: frame.width, height: frame.height, first: frame.pixels[0] });
    return presentResult;
  },
  setInputSink(fn) { this.sink = fn; },
  getStats() { return {}; }
};

const documentStub = {
  hidden: false,
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { listeners.get(type)?.delete(fn); }
};
const windowStub = {
  WebPCGraphicsBridge: bridge,
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
  dispatchEvent() { return true; },
  setInterval(fn) { this.poll = fn; return 7; },
  clearInterval() { this.poll = null; }
};
const CustomEventStub = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};
const performanceStub = { now: () => now };

const heap = new Uint8Array(64);
const mod = {
  HEAPU8: heap, generation: 0, width: 4, height: 2, ptr: 0,
  inputs: [],
  _webpc_get_framebuffer_ptr() { return this.ptr; },
  _webpc_get_framebuffer_width() { return this.width; },
  _webpc_get_framebuffer_height() { return this.height; },
  _webpc_get_framebuffer_generation() { return this.generation; },
  _webpc_send_input(type, code, x, y, buttons) {
    this.inputs.push([type, code, x, y, buttons]);
    return 0;
  }
};

const sandbox = {
  window: windowStub, document: documentStub, performance: performanceStub,
  CustomEvent: CustomEventStub, Uint8Array: TrackedUint8Array,
  Uint8ClampedArray, Set, Number, Object, Math, console
};
vm.runInNewContext(fs.readFileSync("graphics-qemu-adapter.js", "utf8"), sandbox);
const adapter = windowStub.WebPCQemuGraphics;
assert.ok(adapter, "adapter must be exposed");

const statusNode = { textContent: "" };
const missing = adapter.connect({}, canvas, statusNode);
assert.equal(missing.connected, false);
assert.ok(missing.missing.includes("_webpc_get_framebuffer_ptr"));

attachCalls = 0;
const connected = adapter.connect(mod, canvas, statusNode);
assert.equal(connected.connected, true);
assert.equal(attachCalls, 1, "connecting must attach the presenter once (attach itself is idempotent)");
assert.equal(typeof windowStub.poll, "function", "frame polling must start");

heap.fill(9);
mod.generation = 1;             // writer active, no frame yet
windowStub.poll();
assert.equal(presented.length, 0);

mod.generation = 2;             // first complete frame
windowStub.poll();
assert.equal(presented.length, 1);
assert.deepEqual({ w: presented[0].width, h: presented[0].height }, { w: 4, h: 2 });
assert.equal(presented[0].first, 9);
assert.equal(allocations, 1, "one frame copy buffer must be allocated");
assert.equal(adapter.getStats().framesPresented, 1);

now += 40;
windowStub.poll();              // same generation must not be re-presented
assert.equal(presented.length, 1);

mod.generation = 4;
windowStub.poll();
assert.equal(presented.length, 2);
assert.equal(allocations, 1, "the frame copy buffer must be reused");
assert.equal(adapter.getStats().generation, 4);

/* A rate-limited presenter must not consume the frame generation. */
presentResult = false;
now += 40;
mod.generation = 6;
windowStub.poll();
assert.equal(presented.length, 3);
assert.equal(adapter.getStats().generation, 4, "dropped frame is retried");
presentResult = true;
now += 40;
windowStub.poll();
assert.equal(adapter.getStats().generation, 6);
assert.equal(adapter.getStats().framesPresented, 3);

/* A connected ABI that never produces a frame must explain itself. */
now = 25000;
mod.generation = 6;             /* unchanged generation: no new frame */
windowStub.poll();
assert.match(adapter.getStats().lastError, /no guest frame arrived/);
mod.generation = 8;
now += 40;
windowStub.poll();
assert.equal(adapter.getStats().lastError, "", "a real frame clears the stale-runtime hint");
assert.equal(adapter.getStats().framesPresented, 4);

/* Pointer and keyboard events reach the QEMU input queue. */
adapter.sendInput({ type: "pointer", codeValue: 254, x: 100, y: 50, buttons: 1 });
assert.deepEqual(mod.inputs.at(-1), [2, 254, 100, 50, 1]);
adapter.sendKeyCode(87, true);
assert.deepEqual(mod.inputs.at(-1), [1, 17, 0, 0, 1], "W maps to Linux keycode 17");
adapter.sendKeyCode(84, true);
assert.deepEqual(mod.inputs.at(-1), [1, 20, 0, 0, 1], "T maps to Linux keycode 20");
adapter.sendKeyCode(116, true);
assert.deepEqual(mod.inputs.at(-1), [1, 63, 0, 0, 1], "F5 maps to Linux keycode 63");
adapter.sendKeyCode(65, true);
assert.deepEqual(mod.inputs.at(-1), [1, 30, 0, 0, 1], "A maps to Linux keycode 30");

/* Hiding the tab pauses polling and releases keys that are still down. */
documentStub.hidden = true;
for (const fn of listeners.get("visibilitychange")) fn();
assert.equal(windowStub.poll, null);
assert.ok(mod.inputs.some(event => event[0] === 1 && event[2] === 0 && event[4] === 0 && event[1] === 30));
documentStub.hidden = false;
for (const fn of listeners.get("visibilitychange")) fn();
assert.equal(typeof windowStub.poll, "function");

adapter.disconnect();
assert.equal(adapter.getStats().connected, false);
assert.equal(windowStub.poll, null);
console.log("Graphics QEMU adapter tests passed.");
