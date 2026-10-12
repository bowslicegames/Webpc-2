// Exercise the real stack.js HTTP message protocol with a synthetic 40 MiB
// response. The stream is deliberately much larger than the 1 MiB bridge queue.
import fs from "node:fs";

class FakeWorker {
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(message) {
    if (message.type === "init") this.init = message;
  }
}

globalThis.window = {
  location: { origin: "https://webpc.test" },
  WebSocket: class FakeWebSocket {}
};
globalThis.Worker = FakeWorker;

const TOTAL_BYTES = 40 * 1024 * 1024;
const SOURCE_CHUNK_BYTES = 64 * 1024;

globalThis.fetch = async function () {
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (offset >= TOTAL_BYTES) {
        controller.close();
        return;
      }

      const length = Math.min(SOURCE_CHUNK_BYTES, TOTAL_BYTES - offset);
      const chunk = new Uint8Array(length);
      for (let i = 0; i < length; i++) chunk[i] = (offset + i) % 256;
      offset += length;
      controller.enqueue(chunk);
      if (offset >= TOTAL_BYTES) controller.close();
    }
  });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/octet-stream" }
  });
};

// Import the browser ES module from a data URL so Node does not treat the
// repository's .js file as CommonJS. stack.js has no relative imports.
const source = fs.readFileSync(new URL("../stack.js", import.meta.url), "utf8");
const stack = await import("data:text/javascript;charset=utf-8," + encodeURIComponent(source));
stack.Start("ws://webpc.test", "stack-worker.js", "stack.wasm", () => {});

await new Promise(resolve => setTimeout(resolve, 0));
const worker = FakeWorker.last;
if (!worker || !worker.init) throw new Error("stack.js did not initialize its worker");

const shared = worker.init.buf;
const status = new Int32Array(shared, 4, 1);
const length = new Int32Array(shared, 8, 1);
const data = new Uint8Array(shared, 12);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function send(message) {
  worker.onmessage({ data: message });
}

send({
  type: "http_send",
  req: encoder.encode(JSON.stringify({ method: "GET", headers: {} })),
  address: encoder.encode("https://github.com/test-large.bin")
});
const id = status[0];
send({ type: "http_writebody", id, body: new Uint8Array(0), isEOF: true });

let readable = false;
for (let attempt = 0; attempt < 2000; attempt++) {
  send({ type: "http_isreadable", id });
  if (data[0] === 1) {
    readable = true;
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 1));
}
if (!readable) throw new Error("Response metadata never became readable");

send({ type: "http_recv", id, len: data.byteLength });
const metadataLength = length[0];
if (metadataLength <= 0) throw new Error("Missing response metadata");
const metadata = JSON.parse(decoder.decode(data.slice(0, metadataLength)));
if (metadata.status !== 200) throw new Error("Unexpected response status: " + metadata.status);

let received = 0;
let calls = 0;
while (calls++ < 5000) {
  send({ type: "http_readbody", id, len: data.byteLength });
  const count = length[0];
  const resultStatus = status[0];

  for (let i = 0; i < count; i++) {
    const expected = (received + i) % 256;
    if (data[i] !== expected) {
      throw new Error("Payload mismatch at byte " + (received + i) +
        ": got " + data[i] + ", expected " + expected);
    }
  }

  received += count;
  if (resultStatus === -1) throw new Error("Bridge reported stream failure at byte " + received);
  if (resultStatus === 1) break;
  if (count === 0) await new Promise(resolve => setTimeout(resolve, 1));
}

if (received !== TOTAL_BYTES) {
  throw new Error("Truncated/oversized response: received " + received +
    " of " + TOTAL_BYTES + " bytes");
}
if (calls >= 5000) throw new Error("Bridge never reported clean EOF");

console.log("PASS: streamed and verified " + received + " bytes through stack.js");
