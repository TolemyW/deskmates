// A stand-in for a workspace's websockify + x11vnc, for T1 screen tests: an RFB 3.8 server on
// host loopback that demands VNC authentication, accepts the control or the view-only password
// like x11vnc's `-passwdfile`, then echoes every frame. It records which password each
// connection used, so a test sees the Gateway authenticated for the browser.

import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import { ByteReader, vncAuthResponse } from "../api/vnc-relay.js";

export interface FakeVnc {
  address: string;
  /** One entry per authenticated connection: the mode its password unlocked. */
  logins: Array<"control" | "view">;
  sockets: Set<WebSocket>;
  close(): Promise<void>;
}

const toBuffer = (data: Buffer | ArrayBuffer | Buffer[]): Buffer =>
  Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);

export async function startFakeVnc(passwords: { control: string; view: string }): Promise<FakeVnc> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const logins: FakeVnc["logins"] = [];
  const sockets = new Set<WebSocket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const reader = new ByteReader();
    let authenticated = false;
    socket.on("message", (data) => {
      const bytes = toBuffer(data as Buffer | ArrayBuffer | Buffer[]);
      if (authenticated) socket.send(bytes);
      else reader.push(bytes);
    });
    socket.on("close", () => reader.fail(new Error("closed")));
    void (async () => {
      socket.send(Buffer.from("RFB 003.008\n", "latin1"));
      await reader.read(12);
      socket.send(Buffer.from([1, 2]));
      if ((await reader.read(1))[0] !== 2) throw new Error("expected VNC authentication");
      const challenge = randomBytes(16);
      socket.send(challenge);
      const response = await reader.read(16);
      const mode = response.equals(vncAuthResponse(passwords.control, challenge))
        ? "control"
        : response.equals(vncAuthResponse(passwords.view, challenge))
          ? "view"
          : undefined;
      if (!mode) {
        const why = Buffer.from("Authentication failed", "latin1");
        const length = Buffer.alloc(4);
        length.writeUInt32BE(why.length);
        socket.send(Buffer.concat([Buffer.from([0, 0, 0, 1]), length, why]));
        socket.close();
        return;
      }
      logins.push(mode);
      socket.send(Buffer.from([0, 0, 0, 0]));
      authenticated = true;
      const rest = reader.drain();
      if (rest.length > 0) socket.send(rest);
    })().catch(() => socket.terminate());
  });
  return {
    address: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    logins,
    sockets,
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The browser half of the RFB handshake against the Gateway's proxy: it must be offered the
 * `None` security type and never be asked for a password. Resolves once the proxy pipes bytes.
 */
export async function rfbClientHandshake(socket: WebSocket): Promise<ByteReader> {
  const reader = new ByteReader();
  socket.on("message", (data) => reader.push(toBuffer(data as Buffer | ArrayBuffer | Buffer[])));
  socket.on("close", () => reader.fail(new Error("closed")));
  const version = (await reader.read(12)).toString("latin1");
  if (version !== "RFB 003.008\n") throw new Error(`unexpected version ${version}`);
  socket.send(Buffer.from("RFB 003.008\n", "latin1"));
  const count = (await reader.read(1))[0] ?? 0;
  const types = [...(await reader.read(count))];
  if (types.join() !== "1") throw new Error(`expected only None, got ${types.join()}`);
  socket.send(Buffer.from([1]));
  const result = (await reader.read(4)).readUInt32BE(0);
  if (result !== 0) throw new Error("security result failed");
  return reader;
}
