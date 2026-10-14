import { afterEach, describe, expect, it, vi } from "vitest";
import { closeBrowser } from "./close-browser.mjs";

const endpoint = "ws://127.0.0.1:9222/devtools/browser/synthetic";
function fixture(behavior = "ack", target = endpoint) {
  const sent = [];
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({ webSocketDebuggerUrl: target }),
  }));
  class Socket extends EventTarget {
    constructor(url) {
      super();
      expect(url).toBe(endpoint);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(payload) {
      sent.push(JSON.parse(payload));
      queueMicrotask(() => {
        if (behavior === "closed") this.dispatchEvent(new Event("close"));
        else if (behavior !== "hung") {
          const data = JSON.stringify(
            behavior === "error" ? { id: 1, error: {} } : { id: 1, result: {} },
          );
          // Events/unrelated replies are not shutdown acknowledgement.
          this.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify({ id: 9, result: {} }) }),
          );
          this.dispatchEvent(new MessageEvent("message", { data }));
        }
      });
    }
    close() {
      this.dispatchEvent(new Event("close"));
    }
  }
  return { options: { fetcher, WebSocketImpl: Socket }, sent, fetcher };
}
afterEach(() => vi.useRealTimers());
describe("workspace graceful browser shutdown", () => {
  it("requires Browser.close acknowledgement from the fixed loopback browser", async () => {
    const f = fixture();
    await closeBrowser(f.options);
    expect(f.sent).toEqual([{ id: 1, method: "Browser.close" }]);
    expect(f.fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:9222/json/version");
    expect(f.fetcher.mock.calls[0][1].redirect).toBe("error");
  });
  it.each([
    "ws://example.com:9222/devtools/browser/x",
    "ws://127.0.0.1:8765/devtools/browser/x",
    "ws://127.0.0.1:9222/devtools/page/x",
    "ws://user:password@127.0.0.1:9222/devtools/browser/x",
  ])("never follows an unexpected debugger endpoint %s", async (target) => {
    const f = fixture("ack", target);
    await expect(closeBrowser(f.options)).rejects.toThrow();
    expect(f.sent).toEqual([]);
  });
  it("does not treat an error reply as a flush acknowledgement", async () => {
    await expect(closeBrowser(fixture("error").options)).rejects.toThrow("not acknowledged");
  });
  it("does not treat a disconnected browser as a flush acknowledgement", async () => {
    await expect(closeBrowser(fixture("closed").options)).rejects.toThrow("before acknowledgement");
  });
  it("bounds an unresponsive websocket", async () => {
    vi.useFakeTimers();
    const f = fixture("hung");
    const result = expect(closeBrowser({ ...f.options, timeoutMs: 40 })).rejects.toThrow(
      "timed out",
    );
    await vi.advanceTimersByTimeAsync(40);
    await result;
    expect(f.sent).toEqual([{ id: 1, method: "Browser.close" }]);
  });
  it("bounds an unresponsive discovery request", async () => {
    vi.useFakeTimers();
    const result = expect(
      closeBrowser({ fetcher: () => new Promise(() => {}), timeoutMs: 40 }),
    ).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(40);
    await result;
  });
  it("fails on an unavailable discovery endpoint", async () => {
    await expect(closeBrowser({ fetcher: async () => ({ ok: false }) })).rejects.toThrow(
      "endpoint query failed",
    );
  });
});
