/*
 * Regression test for webpc-opfs-writer.js.
 *
 * The worker stores the base disk image through a FileSystemSyncAccessHandle.
 * A bug in its offsets or resume logic silently corrupts the guest disk, so
 * every chunk boundary, the overwrite path and the interrupted-write retry are
 * checked here against an in-memory OPFS stand-in.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");

const QCOW2_MAGIC = [0x51, 0x46, 0x49, 0xfb];
const MiB = 1024 * 1024;

function makeImage(size) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 37 + 11) & 0xff;
  bytes[0] = QCOW2_MAGIC[0];
  bytes[1] = QCOW2_MAGIC[1];
  bytes[2] = QCOW2_MAGIC[2];
  bytes[3] = QCOW2_MAGIC[3];
  return bytes;
}

function createOpfs() {
  const files = new Map();
  const state = { failWrites: 0, closed: 0 };

  function entry(name) {
    if (!files.has(name)) files.set(name, Buffer.alloc(0));
    return files.get(name);
  }

  function grow(buffer, needed) {
    if (buffer.length >= needed) return buffer;
    return Buffer.concat([buffer, Buffer.alloc(needed - buffer.length)]);
  }

  async function getDirectory() {
    return {
      async getFileHandle(name) {
        entry(name);
        return {
          kind: "file",
          async createSyncAccessHandle() {
            return {
              getSize() {
                return entry(name).length;
              },
              truncate(size) {
                const current = entry(name);
                files.set(name, size <= current.length
                  ? current.subarray(0, size)
                  : grow(current, size));
              },
              write(view, options) {
                if (state.failWrites > 0) {
                  state.failWrites -= 1;
                  const error = new Error("The object can not be found here.");
                  error.name = "NotFoundError";
                  throw error;
                }
                const at = (options && options.at) || 0;
                const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
                const target = grow(entry(name), at + bytes.length);
                bytes.copy(target, at);
                files.set(name, target);
                return bytes.length;
              },
              read(view, options) {
                const at = (options && options.at) || 0;
                const target = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
                const current = entry(name);
                const copied = current.copy(target, 0, at, Math.min(current.length, at + target.length));
                return copied;
              },
              flush() {},
              close() {
                state.closed += 1;
              }
            };
          }
        };
      }
    };
  }

  return { files, state, storage: { getDirectory } };
}

function loadWorker(opfs) {
  const source = fs.readFileSync("webpc-opfs-writer.js", "utf8");
  const messages = [];
  let settle = null;
  const finished = new Promise(resolve => { settle = resolve; });
  const self = {
    onmessage: null,
    postMessage(message) {
      messages.push(message);
      if (message.type === "done" || message.type === "error") settle(message);
    }
  };
  // The worker script only needs these three globals; sharing the host realm
  // keeps Blob identity working for its instanceof check.
  new Function("self", "navigator", "Blob", source)(self, { storage: opfs.storage }, Blob);
  return { self, messages, finished };
}

async function runWrite(opfs, bytes, name, chunkBytes) {
  const worker = loadWorker(opfs);
  worker.self.onmessage({ data: { type: "write", name, blob: new Blob([bytes]), chunkBytes } });
  const result = await worker.finished;
  return { result, messages: worker.messages };
}

function assertStored(opfs, name, expected) {
  const stored = opfs.files.get(name);
  assert.ok(stored, "the worker must create " + name);
  assert.strictEqual(stored.length, expected.length, "stored length must match the image");
  assert.strictEqual(Buffer.compare(stored, expected), 0, "stored bytes must match the image");
}

(async () => {
  const small = makeImage(MiB + 1234);
  let opfs = createOpfs();
  let outcome = await runWrite(opfs, small, "small.qcow2", 256 * 1024);
  assert.strictEqual(outcome.result.type, "done", "small image write: " + JSON.stringify(outcome.result));
  assertStored(opfs, "small.qcow2", small);

  const large = makeImage(5 * MiB + 777);
  opfs = createOpfs();
  outcome = await runWrite(opfs, large, "large.qcow2", MiB);
  assert.strictEqual(outcome.result.type, "done", "chunked write: " + JSON.stringify(outcome.result));
  assertStored(opfs, "large.qcow2", large);
  assert.ok(outcome.messages.every(message => message.type === "done"), "no stray messages");

  // Rewriting a longer, fully populated image must replace it exactly.
  const shorter = makeImage(2 * MiB + 5);
  outcome = await runWrite(opfs, shorter, "large.qcow2", MiB);
  assert.strictEqual(outcome.result.type, "done", "overwrite: " + JSON.stringify(outcome.result));
  assertStored(opfs, "large.qcow2", shorter);

  // A transient WebKit NotFoundError must not lose or corrupt the image.
  opfs = createOpfs();
  opfs.state.failWrites = 2;
  outcome = await runWrite(opfs, large, "retry.qcow2", MiB);
  assert.strictEqual(outcome.result.type, "done", "retry write: " + JSON.stringify(outcome.result));
  assertStored(opfs, "retry.qcow2", large);
  assert.ok(
    outcome.messages.some(message => message.type === "retry"),
    "an interrupted write must be reported as a retry"
  );
  assert.ok(opfs.state.closed >= 1, "the failed handle must be closed");

  // An image that is not qcow2 must be rejected instead of booted.
  opfs = createOpfs();
  const bogus = Buffer.alloc(MiB);
  outcome = await runWrite(opfs, bogus, "bogus.qcow2", MiB);
  assert.strictEqual(outcome.result.type, "error", "non-qcow2 image must fail");
  assert.ok(
    /qcow2 header/.test(outcome.result.message),
    "the failure must name the missing qcow2 header: " + outcome.result.message
  );

  console.log("PASS: OPFS writer stores, overwrites and resumes images without corrupting them.");
})().catch(error => {
  console.error("FAIL:", error && error.message ? error.message : error);
  process.exit(1);
});
