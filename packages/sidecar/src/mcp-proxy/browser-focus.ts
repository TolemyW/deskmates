import type { BrowserRpc } from "./browser-coordinator.js";

// MCP 0.0.82 attaches with noDefaults:true, unlike normal Playwright. Without focus emulation,
// a peer making its tab foreground suspends this page's animation frames and ordinary clicks
// cannot complete their stability check. The override belongs to a CDP session: detaching it
// immediately undoes the setting. Keep one session on this MCP connection's Page object until
// the page/connection closes. This emulates visibility/focus; it does not bring a tab forward.
// Host-authored code. Its only parameter is the expected CDP target ID, encoded as a JSON
// string by the host; neither model code nor page text is evaluated here.
export const PREPARE_FOCUS_CODE = `async (page, expectedTabId) => {
  const key = Symbol.for('deskmates.focusSession.v1');
  let session = page[key];
  if (!session) {
    session = await page.context().newCDPSession(page);
    page[key] = session;
  }
  try {
    const { targetInfo } = await session.send('Target.getTargetInfo');
    if (targetInfo.targetId !== expectedTabId) throw new Error('Browser target changed before focus preparation');
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return { tabId: targetInfo.targetId, ready: true };
  } catch (error) {
    delete page[key];
    await session.detach().catch(() => {});
    throw error;
  }
}`;

/** Called only after the selected run target and its lease have been verified. */
export async function prepareBrowserFocus(rpc: BrowserRpc, expectedTabId: string): Promise<void> {
  const result = (await rpc({
    name: "browser_run_code_unsafe",
    arguments: {
      code: `async (page) => (${PREPARE_FOCUS_CODE})(page, ${JSON.stringify(expectedTabId)})`,
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
          value.tabId === expectedTabId &&
          "ready" in value &&
          value.ready === true
        )
          return;
      } catch {}
    }
  }
  if (
    result?.isError &&
    result.content?.some(
      (block) =>
        block.type === "text" && /### Modal state\n- \[File chooser\]:/.test(block.text ?? ""),
    )
  )
    throw new Error(
      "A file chooser is pending on the verified browser target. Use browser_file_upload to complete it, or omit paths to cancel. Normal approvals still apply; do not repeat the opening click.",
    );
  throw new Error(
    "Could not prepare this browser target for background interaction; no action was dispatched.",
  );
}
