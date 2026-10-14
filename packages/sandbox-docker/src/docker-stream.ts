// Demultiplexer for the Docker attach/exec stream format (Tty=false).
// Each frame is an 8-byte header: [type, 0, 0, 0, size(uint32 BE)] followed by `size` bytes.
// type 0 = stdin, 1 = stdout, 2 = stderr. Frames may arrive split across chunks or many per chunk,
// so the demuxer keeps a carry buffer between pushes.

export interface DemuxedOutput {
  stdout: string;
  stderr: string;
}

export const DOCKER_STREAM_HEADER_BYTES = 8;

export class DockerStreamDemuxer {
  private carry: Buffer = Buffer.alloc(0);
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];

  /** Feed the next chunk from the socket. Returns the number of complete frames consumed. */
  push(chunk: Buffer): number {
    let buf = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk]);
    let frames = 0;
    while (buf.length >= DOCKER_STREAM_HEADER_BYTES) {
      const type = buf[0];
      const size = buf.readUInt32BE(4);
      const end = DOCKER_STREAM_HEADER_BYTES + size;
      if (buf.length < end) break;
      const payload = buf.subarray(DOCKER_STREAM_HEADER_BYTES, end);
      if (type === 1) this.stdoutChunks.push(Buffer.from(payload));
      else if (type === 2) this.stderrChunks.push(Buffer.from(payload));
      // type 0 (stdin echo) and unknown types are dropped.
      buf = buf.subarray(end);
      frames += 1;
    }
    this.carry = Buffer.from(buf);
    return frames;
  }

  /** Bytes received that do not yet form a complete frame. Non-zero at close means truncation. */
  get pendingBytes(): number {
    return this.carry.length;
  }

  result(): DemuxedOutput {
    return {
      stdout: Buffer.concat(this.stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(this.stderrChunks).toString("utf8"),
    };
  }
}

/** One-shot helper for a fully buffered stream. */
export function demuxDockerStream(data: Buffer): DemuxedOutput {
  const d = new DockerStreamDemuxer();
  d.push(data);
  return d.result();
}

/** Build a frame; used by tests and by anyone faking the daemon. */
export function encodeDockerFrame(type: 0 | 1 | 2, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const header = Buffer.alloc(DOCKER_STREAM_HEADER_BYTES);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
