import assert from "node:assert/strict";
import { TtySessions } from "/opt/deskmates/sidecar/dist/tty-session.js";
import { createRealDeps } from "/opt/deskmates/sidecar/dist/real-deps.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const native = await import("/opt/deskmates/node_modules/node-pty/lib/index.js");
assert.equal(typeof native.spawn, "function");
const sessions = new TtySessions(createRealDeps().spawnPty, sleep);
const report = { nativePty: true };

try {
  const opened = await sessions.execute({
    action: "open",
    command: 'printf READY; read -r value; printf "GOT=%s" "$value"',
    waitMs: 300,
  });
  assert.match(String(opened.output), /READY/);
  const id = opened.sessionId;
  const written = await sessions.execute({ action: "write", sessionId: id, data: "hello\r", waitMs: 300 });
  assert.match(String(written.output), /GOT=hello/);
  const empty = await sessions.execute({ action: "read", sessionId: id });
  assert.equal(empty.output, "");
  const finished = await sessions.execute({ action: "read", sessionId: id });
  assert.equal(finished.closed, true);
  await sessions.execute({ action: "close", sessionId: id });
  report.interactiveAndIncremental = true;

  const long = await sessions.execute({
    action: "open",
    command: "python3 -c 'import sys; sys.stdout.write(\"X\"*70000); sys.stdout.flush()'",
    waitMs: 1000,
  });
  assert.equal(String(long.output).length, 65536);
  assert.ok(Number(long.droppedCharacters) > 0);
  await sessions.execute({ action: "close", sessionId: long.sessionId });
  report.outputCap = { characters: String(long.output).length, dropped: long.droppedCharacters };

  const slots = [];
  for (let i = 0; i < 4; i++) {
    slots.push((await sessions.execute({ action: "open", command: "sleep 30" })).sessionId);
  }
  await assert.rejects(sessions.execute({ action: "open", command: "sleep 30" }), /limit 4/);
  await sessions.execute({ action: "resize", sessionId: slots[0], cols: 120, rows: 40 });
  await sessions.execute({ action: "close", sessionId: slots.shift() });
  const replacement = await sessions.execute({ action: "open", command: "sleep 30" });
  slots.push(replacement.sessionId);
  report.slotsAndResize = true;
  for (const slot of slots) await sessions.execute({ action: "close", sessionId: slot });

  const interrupted = await sessions.execute({ action: "open", command: "sleep 30" });
  await sessions.execute({ action: "write", sessionId: interrupted.sessionId, data: "\u0003", waitMs: 500 });
  const interruptStatus = await sessions.execute({ action: "read", sessionId: interrupted.sessionId, waitMs: 500 });
  assert.equal(interruptStatus.closed, true);
  await sessions.execute({ action: "close", sessionId: interrupted.sessionId });
  report.ctrlC = true;

  const timed = await sessions.execute({ action: "open", command: "sleep 30", timeoutSeconds: 1 });
  await sleep(1300);
  const timeoutStatus = await sessions.execute({ action: "read", sessionId: timed.sessionId });
  assert.equal(timeoutStatus.closed, true);
  assert.equal(timeoutStatus.timedOut, true);
  await sessions.execute({ action: "close", sessionId: timed.sessionId });
  report.timeout = true;

  await assert.rejects(sessions.execute({ action: "read", sessionId: id }), /Unknown terminal/);
  sessions.dispose();
  await assert.rejects(sessions.execute({ action: "open", command: "true" }), /owner has ended/);
  report.attemptOwnership = true;
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  sessions.dispose();
}
