import { describe, expect, it } from "vitest";
import { DockerStreamDemuxer, demuxDockerStream, encodeDockerFrame } from "./docker-stream.js";

describe("Docker stream demux (Tty=false exec/attach framing)", () => {
  it("separates stdout and stderr frames", () => {
    const data = Buffer.concat([
      encodeDockerFrame(1, "hello "),
      encodeDockerFrame(2, "warn\n"),
      encodeDockerFrame(1, "world\n"),
    ]);
    expect(demuxDockerStream(data)).toEqual({ stdout: "hello world\n", stderr: "warn\n" });
  });

  it("reassembles a frame split across chunks, including inside the header", () => {
    const frame = encodeDockerFrame(1, "abcdefghij");
    const d = new DockerStreamDemuxer();
    expect(d.push(frame.subarray(0, 3))).toBe(0);
    expect(d.pendingBytes).toBe(3);
    expect(d.push(frame.subarray(3, 12))).toBe(0);
    expect(d.push(frame.subarray(12))).toBe(1);
    expect(d.pendingBytes).toBe(0);
    expect(d.result()).toEqual({ stdout: "abcdefghij", stderr: "" });
  });

  it("handles many frames in one chunk and a partial trailer", () => {
    const a = encodeDockerFrame(1, "a");
    const b = encodeDockerFrame(2, "b");
    const c = encodeDockerFrame(1, "ccc");
    const d = new DockerStreamDemuxer();
    expect(d.push(Buffer.concat([a, b, c.subarray(0, 9)]))).toBe(2);
    expect(d.pendingBytes).toBe(9);
    expect(d.push(c.subarray(9))).toBe(1);
    expect(d.result()).toEqual({ stdout: "accc", stderr: "b" });
  });

  it("drops stdin echo and unknown frame types without losing sync", () => {
    const junk = Buffer.concat([encodeDockerFrame(0, "typed"), encodeDockerFrame(1, "ok")]);
    junk[0] = 0;
    const weird = encodeDockerFrame(1, "x");
    weird[0] = 7;
    expect(demuxDockerStream(Buffer.concat([junk, weird, encodeDockerFrame(2, "e")]))).toEqual({
      stdout: "ok",
      stderr: "e",
    });
  });

  it("does not split multi-byte UTF-8 across frame boundaries in the result", () => {
    const text = Buffer.from("héllo wörld", "utf8");
    const d = new DockerStreamDemuxer();
    d.push(encodeDockerFrame(1, text.subarray(0, 2)));
    d.push(encodeDockerFrame(1, text.subarray(2)));
    expect(d.result().stdout).toBe("héllo wörld");
  });

  it("handles empty payload frames", () => {
    expect(demuxDockerStream(encodeDockerFrame(1, ""))).toEqual({ stdout: "", stderr: "" });
  });

  it("reports leftover bytes so a caller can tell a truncated stream from a complete one", () => {
    // This is what DockerProvider.exec checks when the socket closes: a clean end always lands on
    // a frame boundary, so anything left in the carry buffer means output was lost.
    const clean = new DockerStreamDemuxer();
    clean.push(Buffer.concat([encodeDockerFrame(1, "done\n"), encodeDockerFrame(2, "")]));
    expect(clean.pendingBytes).toBe(0);

    const frame = encodeDockerFrame(1, "0123456789");
    // Cut off inside the header: no frame consumed, every byte pending.
    const inHeader = new DockerStreamDemuxer();
    inHeader.push(frame.subarray(0, 5));
    expect(inHeader.pendingBytes).toBe(5);
    expect(inHeader.result()).toEqual({ stdout: "", stderr: "" });

    // Cut off inside the payload: the header is readable but the frame is incomplete, so its
    // bytes stay pending rather than being handed over as if they were the whole answer.
    const inPayload = new DockerStreamDemuxer();
    inPayload.push(Buffer.concat([encodeDockerFrame(1, "kept\n"), frame.subarray(0, 12)]));
    expect(inPayload.pendingBytes).toBe(12);
    expect(inPayload.result()).toEqual({ stdout: "kept\n", stderr: "" });
  });
});
