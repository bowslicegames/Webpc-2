#!/usr/bin/env node
/*
 * WebPC headless guest harness.
 *
 * Boots the *production* QEMU-wasm runtime from the published release under
 * Node, with the same kernel, initramfs, qcow2 disk and QEMU arguments the
 * browser page uses. It exists so a change to the guest launcher can be tested
 * without an iPad and without a human at the keyboard.
 *
 * Two deliberate differences from the browser, both test-only:
 *
 *   1. `navigator.storage` (OPFS) is replaced by a shim in the QEMU pthread
 *      worker that performs the same synchronous random-access I/O on a host
 *      file. The guest therefore still boots from `-drive file=webpc-opfs:...`
 *      with real persistent writes, exactly like Safari, but the disk lives at
 *      .harness/disk/*.qcow2 instead of browser storage.
 *   2. The serial console is a TCP control port instead of xterm, so the
 *      harness can type into the guest and read its output from another
 *      process.
 *
 * Everything else (runtime bytes, firmware, kernel cmdline, guest disk,
 * display pump) is untouched production material.
 *
 * Usage
 *   node tools/webpc-vm.mjs prep                 # download runtime + disk once
 *   node tools/webpc-vm.mjs run [--rescue] [--fresh]
 *   node tools/webpc-vm.mjs ctl status
 *   node tools/webpc-vm.mjs ctl tail [bytes]
 *   node tools/webpc-vm.mjs ctl send "root\r"
 *   node tools/webpc-vm.mjs ctl shot artifacts/shot.png
 *   node tools/webpc-vm.mjs ctl quit
 *
 * The control port defaults to 4719; override with WEBPC_CTL_PORT.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, ".harness");
const ASSETS = path.join(WORK, "assets");
const RUNTIME = path.join(WORK, "runtime");
const DISK_DIR = path.join(WORK, "disk");
const DISK = path.join(DISK_DIR, "webpc-disk.qcow2");
const SERIAL_LOG = path.join(WORK, "serial.log");
const CTL_PORT = Number(process.env.WEBPC_CTL_PORT || 4719);

/*
 * The QEMU runtime release the live Worker serves. The disk, kernel, initramfs
 * and firmware come from the V1 release, matching _worker.js.
 */
const QEMU_RELEASE = "webpc-opfs-43930075815";
const BASE_RELEASE = "V1";
const QEMU_FILES = ["out.js", "qemu-system-x86_64.wasm", "qemu-system-x86_64.worker.js"];
const BASE_FILES = [
  "load-rom.js", "load-rom.data",
  "load-kernel.js", "load-kernel.data",
  "load-initramfs.js", "load-initramfs.data",
  "disk-rootfs-qcow2.img"
];

const log = (...args) => console.log("[harness]", ...args);

/* ------------------------------------------------------------------ prep */

async function download(release, name) {
  const target = path.join(ASSETS, name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    log("have", name, fs.statSync(target).size);
    return;
  }
  const url = `https://github.com/bowslicegames/Webpc-2/releases/download/${release}/${name}`;
  log("download", name);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(target + ".part", bytes);
  fs.renameSync(target + ".part", target);
  log("wrote", name, bytes.length);
}

async function prep() {
  writeShims();
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.mkdirSync(DISK_DIR, { recursive: true });
  for (const name of QEMU_FILES) await download(QEMU_RELEASE, name);
  for (const name of BASE_FILES) await download(BASE_RELEASE, name);
  if (!fs.existsSync(DISK)) {
    fs.copyFileSync(path.join(ASSETS, "disk-rootfs-qcow2.img"), DISK);
    log("seeded writable guest disk at", path.relative(ROOT, DISK));
  }
  buildRuntime();
}

/*
 * Generate the patched worker used only by this harness. It installs the OPFS
 * and PTY shims inside the QEMU main-loop pthread, which is where
 * webpc-opfs.c and the xterm-pty stream operations actually run.
 */
function buildRuntime() {
  fs.mkdirSync(RUNTIME, { recursive: true });
  for (const name of ["out.js", "qemu-system-x86_64.wasm"]) {
    fs.copyFileSync(path.join(ASSETS, name), path.join(RUNTIME, name));
  }
  /* The load-*.js loaders resolve their .data beside the runtime script. */
  for (const name of ["load-rom.data", "load-kernel.data", "load-initramfs.data"]) {
    fs.copyFileSync(path.join(ASSETS, name), path.join(RUNTIME, name));
  }
  const workerSource = fs.readFileSync(path.join(ASSETS, "qemu-system-x86_64.worker.js"), "utf8");
  const shim = fs.readFileSync(path.join(WORK, "worker-shim.js"), "utf8");
  const marker = "var Module = {};";
  if (workerSource.split(marker).length !== 2) {
    throw new Error("worker bootstrap no longer contains exactly one 'var Module = {};'");
  }
  const patched = shim + "\n" + workerSource.replace(marker, "var Module = globalThis.__webpcHarnessModule || {};");
  fs.writeFileSync(path.join(RUNTIME, "qemu-system-x86_64.worker.js"), patched);
}

/* ------------------------------------------------------------- pty shim */

const ptyShimSource = String.raw`
/* WebPC harness PTY: serial bytes over a TCP control socket. */
if (typeof process === "object" && process.versions && process.versions.node) {
  (function () {
    var net = require("net");
    const listeners = { readable: new Set(), writable: new Set(), signal: new Set() };
    const pending = [];
    const stats = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0, ioctls: 0, lastActivity: Date.now() };
    let socket = null;
    let connected = false;

    function fire(name) {
      for (const listener of listeners[name]) {
        try { listener(); } catch (_) {}
      }
    }

    /*
     * QEMU's main loop polls the console and, with an empty PTY, parks there.
     * Under Node that park is a real block on the thread that also runs TCG, so
     * emulated timers stop and the guest halts mid-boot. A cheap wake keeps the
     * main loop turning; reads still report "no data" until bytes arrive.
     */
    const keepAlive = setInterval(() => {
      if (keepAlive.unref) keepAlive.unref();
      fire("readable");
    }, 25);

    function connect() {
      const port = Number(process.env.WEBPC_PTY_PORT || 0);
      if (socket) { try { socket.destroy(); } catch (_) {} }
      if (!port) return;
      socket = net.connect({ port: port, host: "127.0.0.1" }, () => {
        connected = true;
        fire("writable");
      });
      socket.on("data", chunk => {
        for (const byte of chunk) pending.push(byte);
        if (pending.length) fire("readable");
      });
      socket.on("error", () => { connected = false; });
      socket.on("close", () => {
        connected = false;
        setTimeout(connect, 250).unref();
      });
      socket.unref();
    }
    connect();

    const termios = {
      iflag: 0x4500, oflag: 5, cflag: 0xbf, lflag: 0x803b,
      cc: (function () {
        const cc = new Uint8Array(32);
        cc[0] = 3;    /* VINTR ^C */
        cc[1] = 28;   /* VQUIT ^\\ */
        cc[3] = 21;   /* VKILL ^U */
        cc[4] = 4;    /* VEOF ^D */
        cc[6] = 1;    /* VMIN */
        cc[5] = 0;    /* VTIME */
        cc[2] = 127;  /* VERASE DEL */
        return cc;
      })()
    };

    globalThis.__webpcHarnessPty = {
      get readable() { return pending.length > 0; },
      get writable() { return connected; },
      read(length) {
        const bytes = Uint8Array.from(pending.splice(0, length));
        stats.reads++;
        stats.readBytes += bytes.length;
        stats.lastActivity = Date.now();
        return bytes;
      },
      write(bytes) {
        stats.writes++;
        stats.writeBytes += bytes.length;
        stats.lastActivity = Date.now();
        if (socket && connected) socket.write(Buffer.from(bytes));
      },
      ioctl(request, value) {
        if (request === "TCGETS") return termios;
        if (request === "TCSETS") {
          if (value) Object.assign(termios, value);
          return 0;
        }
        stats.ioctls++;
        if (request === "TIOCGWINSZ") return [80, 24];
        return 0;
      },
      stats() { return stats; },
      onReadable(callback) { listeners.readable.add(callback); return { dispose: () => listeners.readable.delete(callback) }; },
      onWritable(callback) { listeners.writable.add(callback); return { dispose: () => listeners.writable.delete(callback) }; },
      onSignal(callback) { listeners.signal.add(callback); return { dispose: () => listeners.signal.delete(callback) }; },
      resize() {}
    };
  })();
}
`;

/* ----------------------------------------------------------- opfs shim */

const opfsShimSource = String.raw`
/* WebPC harness OPFS: the webpc-opfs block driver on a host file. */
if (typeof process === "object" && process.versions && process.versions.node) {
  (function () {
    const fs = require("fs");
    const diskPath = process.env.WEBPC_GUEST_DISK;
    let handle = null;
    const stats = { opens: 0, reads: 0, bytesRead: 0, writes: 0, bytesWritten: 0, truncates: 0, flushes: 0, errors: 0, lastError: null };
    globalThis.__webpcHarnessOpfsStats = () => stats;
    const threadId = (() => { try { return require("worker_threads").threadId; } catch (_) { return "?"; } })();
    setInterval(() => {
      /* Silent until something happened, so a healthy boot stays readable. */
      if (!stats.opens && !stats.errors) return;
      process.stderr.write("[opfs-stats t" + threadId + "] " + JSON.stringify(stats) + "\n");
    }, 20000).unref();
    process.stderr.write("[opfs-shim t" + threadId + "] installed for " + (diskPath || "(no disk)") + "\n");
    function fail(where, error) {
      stats.errors++;
      stats.lastError = where + ": " + (error && error.message ? error.message : String(error));
      process.stderr.write("[opfs] " + stats.lastError + "\n");
    }

    function openHandle() {
      if (handle) return handle;
      if (!diskPath) throw new Error("WEBPC_GUEST_DISK is not set");
      const fd = fs.openSync(diskPath, fs.constants.O_RDWR);
      stats.opens++;
      handle = {
        read(view, options) {
          const at = (options && options.at) || 0;
          try {
            const bytes = fs.readSync(fd, view, 0, view.length, at);
            stats.reads++;
            stats.bytesRead += bytes;
            return bytes;
          } catch (error) {
            fail("read", error);
            return -1;
          }
        },
        write(view, options) {
          const at = (options && options.at) || 0;
          try {
            const bytes = fs.writeSync(fd, view, 0, view.length, at);
            stats.writes++;
            stats.bytesWritten += bytes;
            return bytes;
          } catch (error) {
            fail("write", error);
            return -1;
          }
        },
        getSize() { return fs.fstatSync(fd).size; },
        truncate(size) { stats.truncates++; fs.ftruncateSync(fd, size); },
        flush() { stats.flushes++; fs.fsyncSync(fd); },
        close() { if (fd >= 0) { try { fs.fsyncSync(fd); } catch (_) {} fs.closeSync(fd); } handle = null; }
      };
      return handle;
    }

    globalThis.navigator = globalThis.navigator || {};
    globalThis.navigator.storage = {
      getDirectory: async () => ({
        getFileHandle: async () => ({
          createSyncAccessHandle: async () => openHandle()
        })
      })
    };
  })();
}
`;

function writeShims() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, "worker-shim.js"), ptyShimSource + opfsShimSource);
  fs.writeFileSync(path.join(WORK, "main-shim.mjs"), ptyShimSource);
}

/* ---------------------------------------------------------------- png */

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typeAndBody = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndBody) >>> 0);
    return Buffer.concat([length, typeAndBody, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

/* ----------------------------------------------------------------- run */

async function run(options) {
  writeShims();
  buildRuntime();

  const serialChunks = [];
  let serialBytes = 0;
  const serialStream = fs.createWriteStream(SERIAL_LOG, { flags: "a" });
  serialStream.write(`\n=== harness start ${new Date().toISOString()} rescue=${!!options.rescue} ===\n`);

  const output = bytes => {
    if (!bytes || !bytes.length) return;
    const buffer = Buffer.from(bytes);
    serialBytes += buffer.length;
    serialChunks.push(buffer);
    if (serialChunks.length > 4000) serialChunks.splice(0, 1000);
    serialStream.write(buffer);
  };

  /* Terminal server: every PTY shim connects here. */
  const ptySockets = new Set();
  const ptyServer = net.createServer(socket => {
    ptySockets.add(socket);
    socket.on("data", output);
    socket.on("close", () => ptySockets.delete(socket));
    socket.on("error", () => ptySockets.delete(socket));
  });
  const ptyPort = await new Promise(resolve => {
    ptyServer.listen(0, "127.0.0.1", () => resolve(ptyServer.address().port));
  });

  const sendToGuest = text => {
    const buffer = Buffer.from(text, "utf8");
    for (const socket of ptySockets) socket.write(buffer);
    return ptySockets.size;
  };

  global.require = (await import("node:module")).createRequire(import.meta.url);
  global.process = process;
  global.location = { href: pathToFileURL(WORK + "/").href, pathname: "/" };

  /* The TTY operations are dispatched on the main thread, so the same shim
     has to be installed here as in the QEMU pthread worker. */
  process.env.WEBPC_PTY_PORT = String(ptyPort);
  process.env.WEBPC_GUEST_DISK = DISK;
  vm.runInThisContext(fs.readFileSync(path.join(WORK, "worker-shim.js"), "utf8"), { filename: "webpc-shim.js" });
  const pty = globalThis.__webpcHarnessPty;

  const append = [
    "earlyprintk=ttyS0",
    "console=ttyS0",
    "root=/dev/vda",
    "loglevel=7",
    "hostname=webpc2",
    options.rescue ? "init=/bin/sh" : "",
    options.extraAppend
  ].filter(Boolean).join(" ");

  const Module = {
    wasmBinary: fs.readFileSync(path.join(RUNTIME, "qemu-system-x86_64.wasm")),
    mainScriptUrlOrBlob: pathToFileURL(path.join(RUNTIME, "out.js")).href,
    pty,
    print: text => output(Buffer.from(String(text))),
    printErr: text => output(Buffer.from(String(text))),
    locateFile: name => path.join(RUNTIME, name),
    arguments: [
      "-nographic",
      "-M", "pc",
      "-vga", "std",
      "-usb",
      "-device", "usb-tablet",
      "-m", options.memory,
      "-accel", "tcg,tb-size=64",
      "-L", "/pack-rom/",
      "-nic", "none",
      "-kernel", "/pack-kernel/vmlinuz-virt",
      "-initrd", "/pack-initramfs/initramfs-virt",
      "-append", append,
      ...(options.noDisk ? [] : [
        "-drive", "id=test,file=webpc-opfs:webpc-disk.qcow2,format=qcow2,if=none",
        "-device", "virtio-blk-pci,drive=test"
      ])
    ],
    onExit: code => {
      log("QEMU exited", code);
      process.exit(code === 0 ? 0 : 1);
    }
  };
  global.Module = Module;

  for (const loader of ["load-rom.js", "load-kernel.js", "load-initramfs.js"]) {
    vm.runInThisContext(fs.readFileSync(path.join(ASSETS, loader), "utf8"), { filename: loader });
  }

  const qemu = await import(pathToFileURL(path.join(RUNTIME, "out.js")).href);
  if (typeof qemu.default !== "function") throw new Error("runtime did not export an Emscripten factory");
  log("starting guest; memory", options.memory, "disk", path.relative(ROOT, DISK));
  await qemu.default(Module);
  log("runtime initialized");

  /* ------------------------------------------------------------ control */

  const readExports = () => {
    try {
      const pointer = Module._webpc_get_framebuffer_ptr?.();
      const width = Module._webpc_get_framebuffer_width?.() || 0;
      const height = Module._webpc_get_framebuffer_height?.() || 0;
      const generation = Module._webpc_get_framebuffer_generation?.() || 0;
      return { pointer, width, height, generation };
    } catch (error) {
      return { error: String(error) };
    }
  };

  const snapshot = (file, since) => {
    const frame = readExports();
    let written = null;
    if (file && frame.pointer && frame.width && frame.height) {
      const heap = Module.HEAPU8;
      const size = frame.width * frame.height * 4;
      const rgba = Buffer.from(heap.buffer, frame.pointer, size);
      const target = path.resolve(ROOT, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, encodePng(frame.width, frame.height, rgba));
      written = path.relative(ROOT, target);
    }
    const tail = Buffer.concat(serialChunks).toString("utf8");
    return {
      serialBytes,
      frame,
      screenshot: written,
      serial: typeof since === "number" ? tail.slice(since) : undefined
    };
  };

  const control = net.createServer(socket => {
    let buffer = "";
    socket.on("error", () => {});
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let request;
        try { request = JSON.parse(line); }
        catch (error) { socket.write(JSON.stringify({ error: "bad json" }) + "\n"); continue; }
        try {
          if (request.op === "status") socket.write(JSON.stringify(snapshot()) + "\n");
          else if (request.op === "shot") socket.write(JSON.stringify(snapshot(request.path)) + "\n");
          else if (request.op === "tail") {
            const all = Buffer.concat(serialChunks).toString("utf8");
            const bytes = Number(request.bytes || 4000);
            socket.write(JSON.stringify({ serialBytes, tail: all.slice(-bytes) }) + "\n");
          } else if (request.op === "send") {
            const listeners = sendToGuest(String(request.text ?? ""));
            socket.write(JSON.stringify({ sent: String(request.text ?? ""), ptys: listeners }) + "\n");
          } else if (request.op === "quit") {
            socket.write(JSON.stringify({ ok: true }) + "\n");
            log("quit requested");
            process.exit(0);
          } else socket.write(JSON.stringify({ error: "unknown op" }) + "\n");
        } catch (error) {
          socket.write(JSON.stringify({ error: String(error) }) + "\n");
        }
      }
    });
  });
  control.listen(CTL_PORT, "127.0.0.1", () => log("control port", CTL_PORT, "serial log", path.relative(ROOT, SERIAL_LOG)));

  /* A heartbeat makes a stalled guest distinguishable from a slow one: a live
     guest keeps writing/reading its console every few seconds. */
  setInterval(() => {
    const ptyStats = globalThis.__webpcHarnessPty && globalThis.__webpcHarnessPty.stats
      ? globalThis.__webpcHarnessPty.stats()
      : {};
    const opfsStats = globalThis.__webpcHarnessOpfsStats ? globalThis.__webpcHarnessOpfsStats() : {};
    log("heartbeat", JSON.stringify({ serialBytes, pty: ptyStats, opfs: opfsStats }));
  }, 20000).unref();
}

/* ----------------------------------------------------------------- ctl */

async function ctl(argv) {
  const [command, ...rest] = argv;
  const request =
    command === "status" ? { op: "status" } :
    command === "shot" ? { op: "shot", path: rest[0] } :
    command === "tail" ? { op: "tail", bytes: Number(rest[0] || 4000) } :
    command === "send" ? { op: "send", text: rest.join(" ") } :
    command === "quit" ? { op: "quit" } :
    null;
  if (!request) {
    console.error("usage: ctl status|tail [bytes]|send <text>|shot <png>|quit");
    process.exit(2);
  }
  const socket = net.connect({ port: CTL_PORT, host: "127.0.0.1" });
  socket.on("error", error => {
    console.error("control port unavailable:", error.message);
    process.exit(1);
  });
  socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
  let data = "";
  socket.on("data", chunk => {
    data += chunk.toString("utf8");
    if (data.includes("\n")) {
      process.stdout.write(data);
      socket.end();
    }
  });
}

/* ---------------------------------------------------------------- main */

const argv = process.argv.slice(2);
const command = argv[0] || "run";
const options = {
  rescue: argv.includes("--rescue"),
  memory: (argv.find(arg => arg.startsWith("--memory=")) || "--memory=1024M").split("=")[1],
  noDisk: argv.includes("--no-disk"),
  extraAppend: (argv.find(arg => arg.startsWith("--append=")) || "--append=").slice("--append=".length)
};

if (command === "prep") {
  await prep();
  log("ready");
} else if (command === "run") {
  await run(options);
} else if (command === "ctl") {
  await ctl(argv.slice(1));
} else {
  console.error("usage: webpc-vm.mjs prep|run [--rescue] [--memory=1024M]|ctl <op>");
  process.exit(2);
}
