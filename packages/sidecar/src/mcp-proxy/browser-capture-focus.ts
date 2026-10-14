import type { BrowserRpc } from "./browser-coordinator.js";

export interface BrowserCaptureTarget {
  tabId: string;
  url: string;
}

// A background Chromium target can stall in Page.captureScreenshot even when focus emulation
// reports it as visible. Bring the already verified page to the foreground immediately before
// capture. This code is fixed by the host; its data argument is JSON encoded below.
export const PREPARE_CAPTURE_CODE = `async (page, expected) => {
  const session = await page.context().newCDPSession(page);
  try {
    const before = (await session.send('Target.getTargetInfo')).targetInfo.targetId;
    const beforeUrl = page.url();
    if (before !== expected.tabId || beforeUrl !== expected.url) throw new Error('Browser target changed before capture preparation');
    await page.bringToFront();
    const after = (await session.send('Target.getTargetInfo')).targetInfo.targetId;
    const afterUrl = page.url();
    if (after !== expected.tabId || afterUrl !== expected.url) throw new Error('Browser target changed during capture preparation');
    return { tabId: after, url: afterUrl, ready: true };
  } finally {
    await session.detach().catch(() => {});
  }
}`;

/** Called inside the existing target, takeover-epoch and egress capture fences. */
export async function prepareBrowserCapture(
  rpc: BrowserRpc,
  expected: BrowserCaptureTarget,
): Promise<void> {
  const result = (await rpc({
    name: "browser_run_code_unsafe",
    arguments: {
      code: `async (page) => (${PREPARE_CAPTURE_CODE})(page, ${JSON.stringify(expected)})`,
    },
  })) as { isError?: boolean; content?: { type?: string; text?: string }[] } | undefined;

  if (!result?.isError) {
    for (const block of result?.content ?? []) {
      const match =
        block.type === "text" ? /^### Result\n([^\n]+)(?:\n|$)/m.exec(block.text ?? "") : null;
      if (!match?.[1]) continue;
      try {
        const value: unknown = JSON.parse(match[1]);
        if (
          value !== null &&
          typeof value === "object" &&
          "tabId" in value &&
          value.tabId === expected.tabId &&
          "url" in value &&
          value.url === expected.url &&
          "ready" in value &&
          value.ready === true
        )
          return;
      } catch {}
    }
  }

  throw new Error(
    "Could not prepare this browser target for capture; no screenshot was dispatched.",
  );
}
