// Infrastructure-only fixed targets. No request may select a hostname or destination port.
import net from "node:net";

export function startScreenRelays(host, ports, listenHost = "0.0.0.0") {
  if (!/^deskmates-ws-[a-zA-Z0-9_-]+$/.test(host)) throw new Error("invalid screen relay target");
  const shutdowns = ports.map((port) => {
    const sockets = new Set();
    const server = net.createServer((client) => {
      const upstream = net.connect({ host, port });
      sockets.add(client);
      sockets.add(upstream);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => {
        sockets.delete(client);
        upstream.destroy();
      });
      upstream.on("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      upstream.setTimeout(10_000, () => {
        client.destroy();
        upstream.destroy();
      });
      upstream.once("connect", () => {
        upstream.setTimeout(0);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    });
    server.listen(port, listenHost);
    return () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    };
  });
  return () => {
    for (const shutdown of shutdowns) shutdown();
  };
}
