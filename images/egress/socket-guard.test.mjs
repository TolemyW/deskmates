import { readFileSync } from "node:fs";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { guardSocket } from "./socket-guard.mjs";

describe("guardSocket", () => {
  it("turns a socket error into closing that socket instead of an uncaught exception", async () => {
    const socket = new net.Socket();
    let paired = false;
    guardSocket(socket, () => {
      paired = true;
    });
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => socket.emit("error", epipe)).not.toThrow();
    expect(paired).toBe(true);
    expect(socket.destroyed).toBe(true);
  });

  it("survives a real peer that closes while data is still being written", async () => {
    const server = net.createServer((conn) => {
      guardSocket(conn);
      // Keep writing after the client has gone: the case that crashed the proxy.
      const timer = setInterval(() => conn.write(Buffer.alloc(64 * 1024)), 1);
      conn.once("close", () => clearInterval(timer));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const client = net.connect(port, "127.0.0.1");
    await new Promise((resolve) => client.once("connect", resolve));
    client.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => server.close(resolve));
  });
});

describe("egress-proxy.mjs uses the guard for every socket it owns", () => {
  const source = readFileSync(new URL("./egress-proxy.mjs", import.meta.url), "utf8");

  it("guards each accepted connection and each upstream through track()", () => {
    expect(source).toMatch(/function track\(socket[^)]*\)\s*{\s*guardSocket\(/);
    expect(source).toMatch(/server\.on\("connection", track\)/);
  });

  it("pairs the CONNECT client and upstream so one failing closes the other", () => {
    expect(source).toMatch(/guardSocket\(client, \(\) => upstream\.destroy\(\)\)/);
  });
});
