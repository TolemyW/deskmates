// T0: the RFB handshake the screen proxy performs for the browser (ADR-0022 amendment 1, C7).

import { describe, expect, it } from "vitest";
import { ByteReader, authenticateUpstream, greetClient, vncAuthResponse } from "./vnc-relay.js";

describe("vncAuthResponse", () => {
  it("is DES under the bit-reversed, zero-padded password (known answer)", () => {
    // 0x80 reversed is 0x01, so the DES key is 0101010101010101, whose encryption of a zero
    // block is the textbook 8CA64DE9C1B123A7.
    const response = vncAuthResponse("\x80".repeat(8), Buffer.alloc(16));
    expect(response.toString("hex")).toBe("8ca64de9c1b123a78ca64de9c1b123a7");
  });

  it("uses only the first eight password bytes and pads a shorter one with zeros", () => {
    const challenge = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    expect(vncAuthResponse("abcdefgh-ignored", challenge)).toEqual(
      vncAuthResponse("abcdefgh", challenge),
    );
    expect(vncAuthResponse("abc", challenge)).toEqual(vncAuthResponse("abc\0\0\0\0\0", challenge));
    expect(vncAuthResponse("abcdefgh", challenge)).not.toEqual(
      vncAuthResponse("abcdefgx", challenge),
    );
  });
});

/** Two in-memory ends of a byte stream. */
function pipe() {
  const reader = new ByteReader();
  const sent: Buffer[] = [];
  return { reader, sent, send: (bytes: Buffer) => sent.push(bytes) };
}

describe("authenticateUpstream", () => {
  it("answers the server's challenge with the password and accepts success", async () => {
    const up = pipe();
    const challenge = Buffer.alloc(16, 7);
    up.reader.push(Buffer.from("RFB 003.008\n", "latin1"));
    up.reader.push(Buffer.from([1, 2]));
    up.reader.push(challenge);
    up.reader.push(Buffer.from([0, 0, 0, 0, 9, 9]));
    await authenticateUpstream((n) => up.reader.read(n), up.send, "control1");
    expect(Buffer.concat(up.sent)).toEqual(
      Buffer.concat([
        Buffer.from("RFB 003.008\n", "latin1"),
        Buffer.from([2]),
        vncAuthResponse("control1", challenge),
      ]),
    );
    // Bytes past the handshake (the server's next message) are left for the proxy.
    expect(up.reader.drain()).toEqual(Buffer.from([9, 9]));
  });

  it("throws on a failed SecurityResult, an old version or no usable security type", async () => {
    const failed = pipe();
    failed.reader.push(Buffer.from("RFB 003.008\n", "latin1"));
    failed.reader.push(Buffer.from([1, 2]));
    failed.reader.push(Buffer.alloc(16));
    failed.reader.push(Buffer.from([0, 0, 0, 1, 0, 0, 0, 4]));
    failed.reader.push(Buffer.from("nope", "latin1"));
    await expect(
      authenticateUpstream((n) => failed.reader.read(n), failed.send, "x"),
    ).rejects.toThrow(/authentication failed: nope/);

    const old = pipe();
    old.reader.push(Buffer.from("RFB 003.003\n", "latin1"));
    await expect(authenticateUpstream((n) => old.reader.read(n), old.send, "x")).rejects.toThrow(
      /version/,
    );

    const odd = pipe();
    odd.reader.push(Buffer.from("RFB 003.008\n", "latin1"));
    odd.reader.push(Buffer.from([1, 19]));
    await expect(authenticateUpstream((n) => odd.reader.read(n), odd.send, "x")).rejects.toThrow(
      /no supported security type/,
    );
  });
});

describe("greetClient", () => {
  it("offers the browser only the None security type and never asks for a password", async () => {
    const client = pipe();
    client.reader.push(Buffer.from("RFB 003.008\n", "latin1"));
    client.reader.push(Buffer.from([1]));
    await greetClient((n) => client.reader.read(n), client.send);
    expect(Buffer.concat(client.sent)).toEqual(
      Buffer.concat([
        Buffer.from("RFB 003.008\n", "latin1"),
        Buffer.from([1, 1]),
        Buffer.from([0, 0, 0, 0]),
      ]),
    );
  });

  it("refuses a client that picks another security type", async () => {
    const client = pipe();
    client.reader.push(Buffer.from("RFB 003.008\n", "latin1"));
    client.reader.push(Buffer.from([2]));
    await expect(greetClient((n) => client.reader.read(n), client.send)).rejects.toThrow();
  });
});

describe("ByteReader", () => {
  it("fails pending and later reads once the socket ends", async () => {
    const reader = new ByteReader();
    const pending = reader.read(4);
    reader.fail(new Error("closed"));
    await expect(pending).rejects.toThrow("closed");
    await expect(reader.read(1)).rejects.toThrow("closed");
  });
});
