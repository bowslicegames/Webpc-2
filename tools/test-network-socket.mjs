// Exercise the WebSocket-to-guest shared ring buffer, including lock contention
// and wrap-around cases that the HTTP body-stream test does not cover.
import fs from "node:fs";

class FakeWorker {
  constructor() { FakeWorker.last = this; }
  postMessage(message) { if (message.type === "init") this.init = message; }
}

globalThis.window = {
  location: { origin: "https://webpc.test" },
  WebSocket: class NativeWebSocketStub {}
};
globalThis.Worker = FakeWorker;

const source = fs.readFileSync(new URL("../stack.js", import.meta.url), "utf8");
const stack = await import("data:text/javascript;charset=utf-8," + encodeURIComponent(source));
const address = "ws://webpc.test/";
stack.Start(address, "stack-worker.js", "stack.wasm", () => {});

const received = [];
const socket = new window.WebSocket(address);
socket.onmessage = event => {
  const data = event.data;
  received.push(data instanceof Uint8Array ? Array.from(data) : Array.from(new Uint8Array(data)));
};
await new Promise(resolve => setTimeout(resolve, 0));

const worker = FakeWorker.last;
if (!worker || !worker.init || typeof worker.onmessage !== "function") {
  throw new Error("stack.js did not initialize the fake network worker");
}

const from = worker.init.fromBuf;
const lock = new Int32Array(from, 0, 1);
const begin = new Int32Array(from, 4, 1);
const end = new Int32Array(from, 8, 1);
const data = new Uint8Array(from, 12);

function notify(length) {
  worker.onmessage({ data: { type: "notify-send-from-net", len: length } });
}
function flatten() { return received.flat(); }
async function waitForBytes(count) {
  for (let i = 0; i < 100; i++) {
    if (flatten().length >= count) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for " + count + " delivered bytes; got " + flatten().length);
}

// Lock contention must defer instead of recursively spinning until stack overflow.
data.set([11, 12, 13], 0);
begin[0] = 0;
end[0] = 3;
lock[0] = 1;
notify(3);
setTimeout(() => { lock[0] = 0; }, 8);
await waitForBytes(3);
if (flatten().join(",") !== "11,12,13") {
  throw new Error("Lock-retry payload mismatch: " + flatten().join(","));
}

// Read a frame that crosses the end of the shared ring buffer.
received.length = 0;
const capacity = data.length;
data.fill(0);
const tail = capacity - 8;
data.set([21,22,23,24,25,26,27,28], tail);
data.set([29,30,31,32,33], 0);
begin[0] = tail;
end[0] = 5;
lock[0] = 0;
notify(13);
await waitForBytes(13);
if (flatten().join(",") !== "21,22,23,24,25,26,27,28,29,30,31,32,33") {
  throw new Error("Wrapped ring-buffer payload mismatch: " + flatten().join(","));
}

// An exact-to-the-end read leaves begin at the capacity sentinel; the next
// wrapped read must still deliver bytes from index zero correctly.
received.length = 0;
data.fill(0);
data.set([41,42,43,44], capacity - 4);
begin[0] = capacity - 4;
end[0] = 0;
notify(4);
await waitForBytes(4);
data.set([45,46,47], 0);
end[0] = 3;
notify(3);
await waitForBytes(7);
if (flatten().join(",") !== "41,42,43,44,45,46,47") {
  throw new Error("Exact-wrap boundary payload mismatch: " + flatten().join(","));
}

if (lock[0] !== 0) throw new Error("Shared receive lock was not released");
console.log("PASS: socket ring buffer lock retry, wrap-around and exact-boundary reads");
