// T1 stand-in for the egress proxy's app relay (ADR-0035 decision 4, `images/egress/app-relay.mjs`):
// the same preamble and answers, with every port mapped to a local test server instead of the
// workspace container. Records the ports it was asked for.

import http from "node:http";
import net from "node:net";

export const FAKE_RELAY_KEY = "0123456789abcdef0123456789abcdef";

export interface FakeAppRelay {
  address: string;
  /** Ports requested after a valid key, in order. */
  requested: number[];
  close(): Promise<void>;
}

export async function startFakeAppRelay(ports: ReadonlyMap<number, number>): Promise<FakeAppRelay> {
  const requested: number[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(10);
      if (end < 0) return;
      client.off("data", onData);
      client.pause();
      const match = /^DESKMATES-APP\/1 (\S+) (\d+)$/.exec(buffered.subarray(0, end).toString());
      const rest = buffered.subarray(end + 1);
      if (!match || match[1] !== FAKE_RELAY_KEY) return void client.end("ERR key\n");
      const port = Number(match[2]);
      requested.push(port);
      const local = ports.get(port);
      if (local === undefined) return void client.end("ERR unreachable\n");
      const upstream = net.connect({ host: "127.0.0.1", port: local });
      sockets.add(upstream);
      upstream.on("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      upstream.once("error", () => client.end("ERR unreachable\n"));
      upstream.once("connect", () => {
        upstream.removeAllListeners("error");
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
        client.write("OK\n");
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    address: `127.0.0.1:${addr.port}`,
    requested,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A plain request to the app listener with an explicit `Host`, as a browser would send. */
export function appRequest(
  port: number,
  options: {
    host: string;
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: { host: options.host, ...options.headers },
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}
