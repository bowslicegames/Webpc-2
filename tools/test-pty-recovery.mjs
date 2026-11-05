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

// Restore normal terminal input settings.
master.ldisc.termios = originalTermios;
onData("x");
assert.deepEqual(slave.read(), [120]);

console.log("PASS: raw Ctrl+C reaches the guest PTY and normal input is restored.");
