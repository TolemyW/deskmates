// The RFB security handshake the screen proxy performs on the browser's behalf (ADR-0022
// amendment 1, C7). The workspace's x11vnc asks for VNC authentication with a password the
// Gateway holds in memory; the Gateway answers it upstream and offers the browser the `None`
// security type, so the password never leaves the Gateway and the workspace. After both
// handshakes the proxy only forwards bytes (RFC 6143 section 7.1 and 7.2).

import { createCipheriv } from "node:crypto";

/** RFB 3.8, the version x11vnc and noVNC speak (RFC 6143 section 7.1.1). */
const RFB_VERSION = Buffer.from("RFB 003.008\n", "latin1");
const SECURITY_NONE = 1;
const SECURITY_VNC = 2;

/** Bytes from a WebSocket, read in exact amounts during the handshake. */
export class ByteReader {
  private buffered: Buffer = Buffer.alloc(0);
  private waiter:
    | { n: number; resolve: (bytes: Buffer) => void; reject: (e: Error) => void }
    | undefined;
  private failure: Error | undefined;

  push(bytes: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, bytes]);
    this.settle();
  }

  /** Ends every pending and later read with `reason`. */
  fail(reason: Error): void {
    this.failure ??= reason;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(this.failure);
  }

  read(n: number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiter) return Promise.reject(new Error("one read at a time"));
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject };
      this.settle();
    });
  }

  /** Whatever arrived past the handshake, for the proxy to forward first. */
  drain(): Buffer {
    const rest = this.buffered;
    this.buffered = Buffer.alloc(0);
    return rest;
  }

  private settle(): void {
    const waiter = this.waiter;
    if (!waiter || this.buffered.length < waiter.n) return;
    this.waiter = undefined;
    const bytes = this.buffered.subarray(0, waiter.n);
    this.buffered = this.buffered.subarray(waiter.n);
    waiter.resolve(Buffer.from(bytes));
  }
}

function reverseBits(byte: number): number {
  let out = 0;
  for (let bit = 0; bit < 8; bit += 1) if (byte & (1 << bit)) out |= 1 << (7 - bit);
  return out;
}

/**
 * The VNC authentication response: the 16-byte challenge DES-encrypted under the password, its
 * first eight bytes zero-padded, each byte bit-reversed (the RFB convention). Single DES is
 * Triple DES with three equal keys, which OpenSSL 3 still provides without the legacy provider.
 */
export function vncAuthResponse(password: string, challenge: Buffer): Buffer {
  if (challenge.length !== 16) throw new Error("a VNC challenge is 16 bytes");
  const key = Buffer.alloc(8);
  Buffer.from(password, "latin1").copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i += 1) key[i] = reverseBits(key[i] ?? 0);
  const cipher = createCipheriv("des-ede3-ecb", Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

async function reason(read: (n: number) => Promise<Buffer>): Promise<string> {
  const length = (await read(4)).readUInt32BE(0);
  return length > 0 && length <= 1024 ? (await read(length)).toString("latin1") : "";
}

/** Authenticate to the workspace's VNC server with `password`. Throws on any refusal. */
export async function authenticateUpstream(
  read: (n: number) => Promise<Buffer>,
  send: (bytes: Buffer) => void,
  password: string,
): Promise<void> {
  const version = (await read(12)).toString("latin1");
  const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(version);
  if (!match || Number(match[1]) !== 3 || Number(match[2]) < 8)
    throw new Error(`unsupported upstream RFB version ${JSON.stringify(version)}`);
  send(RFB_VERSION);
  const count = (await read(1))[0] ?? 0;
  if (count === 0) throw new Error(`upstream refused the connection: ${await reason(read)}`);
  const types = [...(await read(count))];
  if (types.includes(SECURITY_VNC)) {
    send(Buffer.from([SECURITY_VNC]));
    send(vncAuthResponse(password, await read(16)));
  } else if (types.includes(SECURITY_NONE)) {
    send(Buffer.from([SECURITY_NONE]));
  } else {
    throw new Error(`upstream offers no supported security type (${types.join(",")})`);
  }
  if ((await read(4)).readUInt32BE(0) !== 0)
    throw new Error(`upstream authentication failed: ${await reason(read)}`);
}

/** Greet the browser as an RFB 3.8 server that needs no authentication. */
export async function greetClient(
  read: (n: number) => Promise<Buffer>,
  send: (bytes: Buffer) => void,
): Promise<void> {
  send(RFB_VERSION);
  const version = (await read(12)).toString("latin1");
  if (version !== RFB_VERSION.toString("latin1"))
    throw new Error(`unsupported client RFB version ${JSON.stringify(version)}`);
  send(Buffer.from([1, SECURITY_NONE]));
  if ((await read(1))[0] !== SECURITY_NONE) throw new Error("client chose another security type");
  send(Buffer.from([0, 0, 0, 0]));
}
