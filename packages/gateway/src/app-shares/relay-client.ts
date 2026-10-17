// The Gateway side of the egress proxy's app relay (ADR-0035 decision 4): open a socket to the
// relay on host loopback, name the port with the proxy's key, and hand back the socket once the
// relay has connected to the workspace service.

import net from "node:net";

export type RelayRefusal = "relay_missing" | "not_running";

export class RelayError extends Error {
  constructor(readonly reason: RelayRefusal) {
    super(reason === "relay_missing" ? "no app relay for this workspace" : "app not running");
  }
}

export interface RelayTarget {
  address?: string | undefined;
  key?: string | undefined;
}

/** Only host loopback is ever dialled, whatever a provider handle says (as for screens). */
const LOOPBACK = /^(127\.0\.0\.1|\[::1\]):(\d{1,5})$/;

export function connectRelay(
  target: RelayTarget,
  port: number,
  timeoutMs = 5_000,
): Promise<net.Socket> {
  const match = target.address ? LOOPBACK.exec(target.address) : null;
  if (!match || !target.key || !/^[0-9a-f]{32}$/.test(target.key))
    return Promise.reject(new RelayError("relay_missing"));
  const host = match[1] === "[::1]" ? "::1" : "127.0.0.1";
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(match[2]) });
    let status = Buffer.alloc(0);
    const fail = (reason: RelayRefusal) => {
      socket.destroy();
      reject(new RelayError(reason));
    };
    const timer = setTimeout(() => fail("not_running"), timeoutMs);
    socket.once("error", () => {
      clearTimeout(timer);
      fail("relay_missing");
    });
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new RelayError("not_running"));
    });
    const onData = (chunk: Buffer) => {
      status = Buffer.concat([status, chunk]);
      const end = status.indexOf(10);
      if (end < 0) {
        if (status.length > 64) fail("not_running");
        return;
      }
      clearTimeout(timer);
      socket.off("data", onData);
      socket.removeAllListeners("close");
      socket.removeAllListeners("error");
      const line = status.subarray(0, end).toString("latin1");
      if (line !== "OK") {
        socket.destroy();
        reject(new RelayError(line === "ERR key" ? "relay_missing" : "not_running"));
        return;
      }
      socket.pause();
      const rest = status.subarray(end + 1);
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    socket.on("data", onData);
    socket.write(`DESKMATES-APP/1 ${target.key} ${port}\n`);
  });
}

/** Whether the service answers through the relay; the socket is closed straight away. */
export async function probeRelay(
  target: RelayTarget,
  port: number,
  timeoutMs = 1_500,
): Promise<RelayRefusal | undefined> {
  try {
    (await connectRelay(target, port, timeoutMs)).destroy();
    return undefined;
  } catch (err) {
    return err instanceof RelayError ? err.reason : "not_running";
  }
}
