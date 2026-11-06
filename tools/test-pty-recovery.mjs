import assert from "node:assert/strict";
import { openpty } from "../xterm-pty/index.mjs";

const { master, slave } = openpty();
let onData;
const fakeTerminal = {
  write() {},
  onData(callback) { onData = callback; return { dispose() {} }; },
  onBinary() { return { dispose() {} }; },
  onResize() { return { dispose() {} }; }
};
master.activate(fakeTerminal);

const signals = [];
slave.onSignal(signal => signals.push(signal));

// Normally Ctrl+C is consumed as a local xterm-pty SIGINT.
onData("\x03");
assert.deepEqual(signals, ["SIGINT"]);
assert.deepEqual(slave.read(), []);

// Recovery disables ISIG temporarily so the literal byte reaches the guest.
const originalTermios = master.ldisc.termios;
const rawTermios = originalTermios.clone();
rawTermios.lflag &= ~(1 | 2);
rawTermios.ISIG_P = false;
rawTermios.ICANON_P = false;
master.ldisc.termios = rawTermios;
onData("\x03");
assert.deepEqual(slave.read(), [3]);
assert.deepEqual(signals, ["SIGINT"]);

// Restore normal terminal input settings before exercising the app broker path.
master.ldisc.termios = originalTermios;
assert.equal(master.ldisc.termios.ISIG_P, true);
assert.equal(master.ldisc.termios.ICANON_P, true);

// The desktop app broker writes through the same line discipline directly.
// This works independently of xterm's visible stdin lock during app tasks.
assert.equal(typeof master.write, "undefined");
master.ldisc.writeFromLower("printf 'APP_TASK_OK'\r");
assert.deepEqual(slave.read(), Array.from(new TextEncoder().encode("printf 'APP_TASK_OK'\n")));

console.log("PASS: raw Ctrl+C recovery and direct app-task PTY input both work.");
