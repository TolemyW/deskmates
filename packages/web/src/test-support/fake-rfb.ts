// A stand-in for noVNC's RFB client in jsdom tests: records how each screen was opened, so a test
// sees that the stream goes through the Gateway's screen proxy (`/api/desktop-stream`, the
// ticket as the WebSocket subprotocol) and that no VNC password is ever passed (ADR-0022
// amendment 1, C7). Use with `vi.mock("@novnc/novnc", () => ({ default: FakeRfb }))`.

export interface RfbOpening {
  url: string;
  options: Record<string, unknown> | undefined;
  viewOnly: boolean;
  disconnected: boolean;
}

export const rfbOpenings: RfbOpening[] = [];

export class FakeRfb extends EventTarget {
  private readonly opening: RfbOpening;
  scaleViewport = false;
  resizeSession = false;
  background = "";

  constructor(_target: HTMLElement, url: string, options?: Record<string, unknown>) {
    super();
    this.opening = { url, options, viewOnly: false, disconnected: false };
    rfbOpenings.push(this.opening);
  }

  set viewOnly(value: boolean) {
    this.opening.viewOnly = value;
  }

  get viewOnly(): boolean {
    return this.opening.viewOnly;
  }

  disconnect(): void {
    this.opening.disconnected = true;
  }

  focus(): void {}
}
