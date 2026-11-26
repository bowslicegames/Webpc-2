#!/usr/bin/env node
/*
 * Drive the headless guest through the same Minecraft launch the page performs.
 *
 * Assumes `node tools/webpc-vm.mjs run` is already running and answering on the
 * control port. Every step is read back from the guest's serial console, so a
 * pass means the guest actually printed the evidence, not that a command was
 * delivered.
 *
 * Usage
 *   node tools/webpc-minecraft-test.mjs --login [--user root] [--password-env WEBPC_GUEST_PASSWORD]
 *   node tools/webpc-minecraft-test.mjs --launch
 *   node tools/webpc-minecraft-test.mjs --expect "painted the X root window" --timeout 900
 *   node tools/webpc-minecraft-test.mjs --shot artifacts/prism.png
 *
 * Environment
 *   WEBPC_CTL_PORT        control port (default 4719)
 *   WEBPC_GUEST_PASSWORD  guest root password; never stored in the repo
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERIAL_LOG = path.join(ROOT, ".harness", "serial.log");
const CTL_PORT = Number(process.env.WEBPC_CTL_PORT || 4719);

function ctl(request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port: CTL_PORT, host: "127.0.0.1" });
    let data = "";
    socket.on("error", error => reject(new Error("control port unavailable: " + error.message)));
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", chunk => {
      data += chunk.toString("utf8");
      const newline = data.indexOf("\n");
      if (newline >= 0) {
        socket.end();
        try { resolve(JSON.parse(data.slice(0, newline))); }
        catch (error) { reject(error); }
      }
    });
  });
}

const send = text => ctl({ op: "send", text });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/* Serial bytes are already on disk; do not hold the whole boot in memory. */
function serialSize() {
  try { return fs.statSync(SERIAL_LOG).size; } catch (_) { return 0; }
}

function serialSlice(from) {
  const size = serialSize();
  if (size <= from) return "";
  const fd = fs.openSync(SERIAL_LOG, "r");
  try {
    const length = Math.min(size - from, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, from);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

async function expect(pattern, { timeoutMs = 600000, from = 0, label = pattern } = {}) {
  const expression = new RegExp(pattern, "i");
  const deadline = Date.now() + timeoutMs;
  let cursor = from;
  let seen = "";
  while (Date.now() < deadline) {
    const chunk = serialSlice(cursor);
    if (chunk) {
      cursor += Buffer.byteLength(chunk);
      seen = (seen + chunk).slice(-20000);
      if (expression.test(seen)) {
        console.log("PASS:", label);
        return { ok: true, at: cursor, tail: seen.slice(-1200) };
      }
    }
    await wait(1000);
  }
  console.log("FAIL:", label, "after", Math.round(timeoutMs / 1000), "s");
  console.log("--- last serial output ---");
  console.log(serialSlice(Math.max(0, cursor - 4000)));
  return { ok: false, at: cursor };
}

/*
 * Deliver the launcher exactly the way index.html does: base64 the script,
 * write it in chunks to a temporary file, then run it detached with its own log.
 */
async function launchLauncher() {
  const source = fs.readFileSync(path.join(ROOT, "tools", "webpc-minecraft-display.sh"));
  const encoded = source.toString("base64");
  const file = "/tmp/.webpc-harness-launcher.b64";
  await send("stty -echo 2>/dev/null\r");
  await wait(200);
  await send(": > " + file + "\r");
  await wait(200);
  for (let offset = 0; offset < encoded.length; offset += 700) {
    await send("printf '%s' '" + encoded.slice(offset, offset + 700) + "' >> " + file + "\r");
    await wait(120);
  }
  await send(
    "base64 -d " + file + " > /usr/local/bin/webpc-minecraft-display && " +
    "chmod 755 /usr/local/bin/webpc-minecraft-display && " +
    "stty echo 2>/dev/null; echo HARNESS_LAUNCHER_WRITTEN\r"
  );
  const written = await expect("HARNESS_LAUNCHER_WRITTEN", { timeoutMs: 120000, from: Math.max(0, serialSize() - 20000) });
  if (!written.ok) return written;
  await send(
    "nohup /usr/local/bin/webpc-minecraft-display </dev/null " +
    ">/var/log/webpc-minecraft-launcher.log 2>&1 & echo HARNESS_LAUNCHER_STARTED\r"
  );
  return expect("HARNESS_LAUNCHER_STARTED", { timeoutMs: 60000, from: Math.max(0, serialSize() - 20000) });
}

/* ---------------------------------------------------------------- main */

const argv = process.argv.slice(2);
const readFlag = name => argv.includes(name);
const readOption = name => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const actions = [];

if (readFlag("--expect")) {
  actions.push(() => expect(readOption("--expect"), {
    timeoutMs: Number(readOption("--timeout") || 600) * 1000,
    from: 0,
    label: readOption("--expect")
  }));
}

if (readFlag("--launch")) {
  actions.push(() => launchLauncher());
}

if (readFlag("--shot")) {
  actions.push(async () => {
    const result = await ctl({ op: "shot", path: readOption("--shot") });
    console.log("screenshot:", JSON.stringify(result.frame), "->", result.screenshot);
    return { ok: !!result.screenshot };
  });
}

if (actions.length === 0) {
  console.error("usage: --expect <regex> [--timeout s] | --launch | --shot <png>");
  process.exit(2);
}

let ok = true;
for (const action of actions) {
  const result = await action();
  ok = ok && result.ok !== false;
}
process.exit(ok ? 0 : 1);
