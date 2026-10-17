// The app relay (ADR-0035 decision 4): the Gateway's only inward path to a published workspace
// service. The target host is the fixed workspace container name from the provider; a connection
// names only a port, after a preamble carrying this proxy's relay key. Infrastructure ports are
// refused here even if the Gateway asked for them; which ports are published is the Gateway's
// record, not this process's.
import { timingSafeEqual } from "node:crypto";
import net from "node:net";

export const APP_RELAY_PORT = 6090;
const PREAMBLE_MAX = 160;
const PREAMBLE_MS = 5_000;
const CONNECT_MS = 5_000;

/** Ports the relay never forwards to: privileged ports and the screen relays (6080-6086). */
export function appPortAllowed(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && !(port >= 6080 && port <= 6086);
}

function keyMatches(expected, presented) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A server that reads `DESKMATES-APP/1 <key> <port>\n`, answers `OK\n` and pipes to
 * `<host>:<port>`, or answers `ERR <reason>\n` and closes. `connect` is injectable for tests.
 */
export function createAppRelayServer({ host, key, connect = net.connect }) {
  if (!/^[0-9a-f]{32,}$/.test(key)) throw new Error("invalid app relay key");
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    let buffered = Buffer.alloc(0);
    let upstream;
    const refuse = (reason) => {
      if (client.writable) client.end(`ERR ${reason}\n`);
      else client.destroy();
    };
    const timer = setTimeout(() => refuse("timeout"), PREAMBLE_MS);
    client.on("error", () => upstream?.destroy());
    client.on("close", () => {
      clearTimeout(timer);
      sockets.delete(client);
      upstream?.destroy();
    });
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(10);
      if (end < 0) {
        if (buffered.length > PREAMBLE_MAX) refuse("preamble");
        return;
      }
      client.off("data", onData);
      client.pause();
      clearTimeout(timer);
      const match = /^DESKMATES-APP\/1 (\S+) (\d{1,5})$/.exec(
        buffered.subarray(0, end).toString("latin1"),
      );
      const rest = buffered.subarray(end + 1);
      if (!match || !keyMatches(key, match[1])) return refuse("key");
      const port = Number(match[2]);
      if (!appPortAllowed(port)) return refuse("port");
      upstream = connect({ host, port });
      sockets.add(upstream);
      upstream.setTimeout(CONNECT_MS, () => {
        upstream.destroy();
        refuse("unreachable");
      });
      upstream.once("error", () => refuse("unreachable"));
      upstream.on("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      upstream.once("connect", () => {
        upstream.setTimeout(0);
        upstream.removeAllListeners("error");
        upstream.on("error", () => client.destroy());
        client.write("OK\n");
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
    };
    client.on("data", onData);
  });
  const close = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  return { server, close };
}

/** Start the relay for the fixed workspace container `host`, as the proxy entry point does. */
export function startAppRelay(host, key, listenHost = "0.0.0.0") {
  if (!/^deskmates-ws-[a-zA-Z0-9_-]+$/.test(host)) throw new Error("invalid app relay target");
  const relay = createAppRelayServer({ host, key });
  relay.server.listen(APP_RELAY_PORT, listenHost);
  return relay.close;
}
