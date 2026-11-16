/*
 * WebPC OPFS base-disk writer.
 *
 * The guest base image is hundreds of megabytes. Safari/WebKit cannot store an
 * image that size through FileSystemWritableFileStream: WebKit backs the stream
 * with a temporary file and, once that backing file is invalidated partway
 * through a large write, every later write fails with NotFoundError
 * ("The object can not be found here.") and the browser is left without a
 * usable disk.
 *
 * FileSystemSyncAccessHandle writes the image in place with explicit offsets,
 * has no temporary-file commit step, and is the OPFS write path WebKit fully
 * implements. It only exists inside a dedicated worker, so the image is
 * streamed into OPFS from here.
 *
 * Writes are resumable inside one session: progress is flushed every
 * FLUSH_INTERVAL_BYTES and a failed handle is reopened and continued from the
 * last flushed byte, so a transient WebKit storage failure no longer costs the
 * whole download.
 */
"use strict";

const MIN_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024;
const FLUSH_INTERVAL_BYTES = 32 * 1024 * 1024;
const PROGRESS_INTERVAL_BYTES = 64 * 1024 * 1024;
const MAX_ATTEMPTS = 4;

const QCOW2_MAGIC = [0x51, 0x46, 0x49, 0xfb];

self.onmessage = event => {
  const message = event.data || {};
  if (message.type !== "write" || !(message.blob instanceof Blob)) return;
  writeDiskImage(message).then(
    () => self.postMessage({ type: "done", size: message.blob.size }),
    error => self.postMessage({
      type: "error",
      name: error && error.name ? String(error.name) : "Error",
      message: error && error.message ? String(error.message) : String(error)
    })
  );
};

function clampChunkBytes(value) {
  const requested = Number(value) || DEFAULT_CHUNK_BYTES;
  return Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, requested));
}

async function openAccessHandle(name) {
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(name, { create: true });
  return fileHandle.createSyncAccessHandle();
}

function readMagic(access) {
  const header = new Uint8Array(4);
  return access.read(header, { at: 0 }) === 4 ? Array.from(header) : null;
}

function hasQcow2Magic(bytes) {
  return !!bytes && QCOW2_MAGIC.every((byte, index) => bytes[index] === byte);
}

async function writeDiskImage({ name, blob, chunkBytes }) {
  const size = blob.size;
  const chunk = clampChunkBytes(chunkBytes);
  let written = 0;
  let flushed = 0;
  let reported = 0;
  let attempt = 0;

  for (;;) {
    let access = null;
    try {
      access = await openAccessHandle(name);
      // An interrupted earlier attempt can leave a shorter file (the tail was
      // never committed) or a larger one. Every byte at or after `written` is
      // rewritten below, so only the size needs adjusting here.
      if (access.getSize() !== size) access.truncate(size);
      if (written > 0 && !hasQcow2Magic(readMagic(access))) {
        // The entry was recreated underneath us and nothing written so far
        // survived. Start over rather than leaving a corrupt image behind.
        written = 0;
        flushed = 0;
        reported = 0;
      }
      while (written < size) {
        const end = Math.min(size, written + chunk);
        const buffer = new Uint8Array(await blob.slice(written, end).arrayBuffer());
        let offset = 0;
        while (offset < buffer.length) {
          // Pass a view whose backing buffer is exactly the bytes to store:
          // older Safari builds mishandle non-zero byte offsets on writes.
          const view = offset === 0 ? buffer : buffer.slice(offset);
          const stored = access.write(view, { at: written + offset });
          if (!(stored > 0)) {
            throw new Error(
              "OPFS stored 0 of " + view.length + " bytes at offset " + (written + offset)
            );
          }
          offset += stored;
        }
        written = end;
        if (written - flushed >= FLUSH_INTERVAL_BYTES || written === size) {
          access.flush();
          flushed = written;
        }
        if (flushed === written && written - reported >= PROGRESS_INTERVAL_BYTES) {
          reported = written;
          self.postMessage({ type: "progress", written, size });
        }
      }
      if (!hasQcow2Magic(readMagic(access))) {
        throw new Error("the stored disk image does not start with a qcow2 header");
      }
      access.flush();
      access.close();
      access = null;
      return;
    } catch (error) {
      if (access) {
        try { access.close(); } catch (_) {}
      }
      attempt += 1;
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(
          "OPFS sync-access write failed after " + attempt + " attempts: " +
          (error && error.message ? error.message : String(error))
        );
      }
      // Only flushed bytes are guaranteed to be in the file, so resume there.
      if (written > flushed) written = flushed;
      self.postMessage({
        type: "retry",
        attempt,
        written,
        size,
        message: error && error.message ? String(error.message) : String(error)
      });
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
}
