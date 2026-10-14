import type { BrowserCall } from "./browser-coordinator.js";

export const MAX_RETENTION_CLOSES_PER_START = 20;

/**
 * Host-authored Playwright code: targetId is encoded as a string literal, never executable input.
 * The current page and the last remaining page are retained even if the Gateway supplied them.
 */
export function retentionCloseCall(targetId: string): BrowserCall {
  const encoded = JSON.stringify(targetId);
  return {
    name: "browser_run_code_unsafe",
    arguments: {
      code: `async (page) => {
  const targetId = ${encoded};
  const context = page.context();
  const pages = context.pages();
  async function id(candidate) {
    const session = await context.newCDPSession(candidate);
    try { return (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await session.detach(); }
  }
  const currentId = await id(page);
  if (targetId === currentId || pages.length <= 1)
    return { deskmatesRetention: 1, targetId, closed: false };
  for (const candidate of pages) {
    if (await id(candidate) !== targetId) continue;
    await candidate.close();
    return { deskmatesRetention: 1, targetId, closed: true };
  }
  return { deskmatesRetention: 1, targetId, closed: false };
}`,
    },
  };
}

export function parseRetentionReceipt(
  result: unknown,
  expectedTargetId: string,
): "closed" | "missing" | undefined {
  const content = (result as { content?: { type?: string; text?: string }[] } | undefined)?.content;
  for (const block of content ?? []) {
    if (block.type !== "text" || !block.text) continue;
    const match = /^### Result\n([^\n]+)(?:\n|$)/m.exec(block.text);
    if (!match?.[1]) continue;
    try {
      const value = JSON.parse(match[1]) as {
        deskmatesRetention?: unknown;
        targetId?: unknown;
        closed?: unknown;
      };
      if (value.deskmatesRetention !== 1 || value.targetId !== expectedTargetId) return undefined;
      if (value.closed === true) return "closed";
      if (value.closed === false) return "missing";
    } catch {}
  }
  return undefined;
}
