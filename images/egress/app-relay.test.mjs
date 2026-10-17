import { readFileSync } from "node:fs";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { appPortAllowed, createAppRelayServer, startAppRelay } from "./app-relay.mjs";

const KEY = "0123456789abcdef0123456789abcdef";
const closers = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/** An echo service standing in for the workspace app, and a relay whose every target is it. */
async function setup() {
  const echo = net.createServer((conn) => conn.pipe(conn));
  const echoPort = await listen(echo);
  closers.push(() => echo.close());
  const seen = [];
  const relay = createAppRelayServer({
    host: "deskmates-ws-test",
    key: KEY,
    connect: ({ host, port }) => {
      seen.push({ host, port });
      return net.connect({ host: "127.0.0.1", port: port === 4000 ? echoPort : 1 });
    },
  });
  const relayPort = await listen(relay.server);
  closers.push(relay.close);
  return { relayPort, seen };
}

function exchange(port, preamble, payload = "") {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString("latin1");
      if (text.startsWith("OK\n") && text.length >= 3 + payload.length) socket.end();
    });
    socket.on("close", () => resolve(text));
    socket.on("error", () => resolve(text));
    socket.write(preamble + payload);
  });
}

describe("app relay (ADR-0035 decision 4)", () => {
  it("pipes to the fixed workspace container on the named port after a valid preamble", async () => {
    const { relayPort, seen } = await setup();
    expect(await exchange(relayPort, `DESKMATES-APP/1 ${KEY} 4000\n`, "ping")).toBe("OK\nping");
    expect(seen).toEqual([{ host: "deskmates-ws-test", port: 4000 }]);
  });

  it("refuses a wrong key without connecting anywhere", async () => {
    const { relayPort, seen } = await setup();
    expect(await exchange(relayPort, `DESKMATES-APP/1 ${"f".repeat(32)} 4000\n`)).toBe("ERR key\n");
    expect(seen).toEqual([]);
  });

  it("refuses privileged and screen relay ports", async () => {
    const { relayPort, seen } = await setup();
    for (const port of [22, 80, 6080, 6086])
      expect(await exchange(relayPort, `DESKMATES-APP/1 ${KEY} ${port}\n`)).toBe("ERR port\n");
    expect(seen).toEqual([]);
    expect(appPortAllowed(1024)).toBe(true);
    expect(appPortAllowed(9222)).toBe(true);
    expect(appPortAllowed(65536)).toBe(false);
  });

  it("reports a port with nothing listening as unreachable", async () => {
    const { relayPort } = await setup();
    expect(await exchange(relayPort, `DESKMATES-APP/1 ${KEY} 5000\n`)).toBe("ERR unreachable\n");
  });

  it("only targets a workspace container name and requires a real key", () => {
    expect(() => startAppRelay("evil.example", KEY)).toThrow(/target/);
    expect(() => createAppRelayServer({ host: "deskmates-ws-a", key: "short" })).toThrow(/key/);
  });

  it("is started by the proxy entry point and shipped in the image", () => {
    const entry = readFileSync(new URL("./egress-proxy.mjs", import.meta.url), "utf8");
    expect(entry).toMatch(/startAppRelay\(/);
    const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toMatch(/app-relay\.mjs/);
    expect(dockerfile).toMatch(/EXPOSE .*\b6090\b/);
  });
});
