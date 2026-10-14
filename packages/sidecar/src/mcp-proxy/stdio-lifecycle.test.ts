import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { guardProxyPipes } from "./stdio-lifecycle.js";

function disconnectedPipe(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error("peer disconnected"), { code: "EPIPE" }));
    },
  });
}

describe("MCP stdio lifecycle", () => {
  it("handles a client disconnect on the final empty drain without an uncaught error", async () => {
    const output = disconnectedPipe();
    const childInput = new PassThrough();
    let disconnects = 0;
    const pipes = guardProxyPipes(output, childInput, () => disconnects++);
    await pipes.close();
    expect(pipes.failed()).toBe(true);
    expect(disconnects).toBe(1);
    expect(output.listenerCount("error")).toBe(0);
    expect(childInput.listenerCount("error")).toBe(0);
  });

  it("ends the session once when either forwarding pipe fails", async () => {
    const output = disconnectedPipe();
    const childInput = disconnectedPipe();
    let disconnects = 0;
    const pipes = guardProxyPipes(output, childInput, () => disconnects++);
    output.write("a pending browser result\n");
    childInput.write("a pending browser call\n");
    await setImmediate();
    await pipes.close();
    expect(disconnects).toBe(1);
    expect(pipes.failed()).toBe(true);
  });

  it("drains a slow final result before allowing the proxy to exit", async () => {
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        setImmediate().then(() => {
          chunks.push(String(chunk));
          callback();
        });
      },
    });
    const childInput = new PassThrough();
    let disconnects = 0;
    const pipes = guardProxyPipes(output, childInput, () => disconnects++);
    output.write("final browser result\n");
    await pipes.close();
    expect(chunks.join("")).toBe("final browser result\n");
    expect(pipes.failed()).toBe(false);
    expect(disconnects).toBe(0);
  });
});
