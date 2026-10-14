import { describe, expect, it, vi } from "vitest";
import {
  type BrowserCaptureTarget,
  PREPARE_CAPTURE_CODE,
  prepareBrowserCapture,
} from "./browser-capture-focus.js";

const expected = {
  tabId: "own-target",
  url: "http://localhost:8082/tickets?owner=one",
} satisfies BrowserCaptureTarget;

const result = (value: unknown) => ({
  content: [{ type: "text", text: `### Result\n${JSON.stringify(value)}\n` }],
});

function protocolPage(options?: {
  beforeTabId?: string;
  beforeUrl?: string;
  afterTabId?: string;
  afterUrl?: string;
  bringError?: Error;
}) {
  let targetRead = 0;
  let urlRead = 0;
  const detach = vi.fn(async () => {});
  const bringToFront = vi.fn(async () => {
    if (options?.bringError) throw options.bringError;
  });
  const page = {
    context: () => ({
      newCDPSession: async () => ({
        send: async (method: string) => {
          expect(method).toBe("Target.getTargetInfo");
          targetRead += 1;
          return {
            targetInfo: {
              targetId:
                targetRead === 1
                  ? (options?.beforeTabId ?? expected.tabId)
                  : (options?.afterTabId ?? expected.tabId),
            },
          };
        },
        detach,
      }),
    }),
    url: () => {
      urlRead += 1;
      return urlRead === 1
        ? (options?.beforeUrl ?? expected.url)
        : (options?.afterUrl ?? expected.url);
    },
    bringToFront,
  };
  return { page, bringToFront, detach };
}

const runHostCode = new Function(`return (${PREPARE_CAPTURE_CODE});`)() as (
  page: ReturnType<typeof protocolPage>["page"],
  target: BrowserCaptureTarget,
) => Promise<{ tabId: string; url: string; ready: boolean }>;

describe("browser capture foreground preparation", () => {
  it("verifies the exact target and URL before and after bringing the page forward", async () => {
    const { page, bringToFront, detach } = protocolPage();

    await expect(runHostCode(page, expected)).resolves.toEqual({ ...expected, ready: true });
    expect(bringToFront).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledOnce();
  });

  it.each([
    ["wrong target", { beforeTabId: "peer-target" }],
    ["wrong URL", { beforeUrl: "http://localhost:8082/other" }],
  ])("does not bring the page forward for a %s", async (_label, options) => {
    const { page, bringToFront, detach } = protocolPage(options);

    await expect(runHostCode(page, expected)).rejects.toThrow("changed before");
    expect(bringToFront).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledOnce();
  });

  it("detaches the temporary CDP session when bringToFront fails", async () => {
    const { page, detach } = protocolPage({ bringError: new Error("target closed") });

    await expect(runHostCode(page, expected)).rejects.toThrow("target closed");
    expect(detach).toHaveBeenCalledOnce();
  });

  it.each([
    ["target", { afterTabId: "peer-target" }],
    ["URL", { afterUrl: "http://localhost:8082/redirected" }],
  ])("fails closed if the %s changes after foregrounding", async (_label, options) => {
    const { page, bringToFront, detach } = protocolPage(options);

    await expect(runHostCode(page, expected)).rejects.toThrow("changed during");
    expect(bringToFront).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledOnce();
  });

  it("accepts only an exact successful MCP result", async () => {
    await expect(
      prepareBrowserCapture(async () => result({ ...expected, ready: true }), expected),
    ).resolves.toBeUndefined();

    for (const malformed of [
      { ...expected, tabId: "peer-target", ready: true },
      { ...expected, url: "http://localhost:8082/other", ready: true },
      { ...expected, ready: false },
      null,
    ]) {
      await expect(prepareBrowserCapture(async () => result(malformed), expected)).rejects.toThrow(
        "no screenshot was dispatched",
      );
    }
    await expect(
      prepareBrowserCapture(
        async () => ({ ...result({ ...expected, ready: true }), isError: true }),
        expected,
      ),
    ).rejects.toThrow("no screenshot was dispatched");
    await expect(
      prepareBrowserCapture(
        async () => ({ content: [{ type: "text", text: "not MCP JSON" }] }),
        expected,
      ),
    ).rejects.toThrow("no screenshot was dispatched");
  });

  it("JSON encodes target data in the fixed host program", async () => {
    const calls: unknown[] = [];
    const hostile = { tabId: "target'\\n", url: "http://localhost/path?value='\\n" };
    await prepareBrowserCapture(async (call) => {
      calls.push(call);
      return result({ ...hostile, ready: true });
    }, hostile);

    expect(calls).toHaveLength(1);
    const code = (calls[0] as { arguments: { code: string } }).arguments.code;
    expect(code).toContain(JSON.stringify(hostile));
  });
});
