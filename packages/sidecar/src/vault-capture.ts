// Capture suppression after a Vault fill (ADR-0045 decision 7). Once a credential is filled into
// a run's tab, the ordinary later paths would carry it out: the accessibility snapshot shows a
// text field's value (the username), a screenshot shows it, and page code can read either field.
// So the run marks the tab, and while the tab still shows the page that was filled the browser
// proxy masks field values in snapshot text, replaces images with a notice, withholds the output
// of page code, and writes no run screenshot. The mark holds no value: a tab id, a URL and a time.
// It ends when the tab navigates away.
//
// This is masking of the normal paths, not secrecy: a malicious page can encode, transform or
// render the value in ways no mask recognizes, and anything in the workspace can read the shared
// browser (decision 9). The mark is per run; another bot's own tab is not masked.

import { readFile, rm, writeFile } from "node:fs/promises";

export interface VaultCaptureMark {
  version: 1;
  runId: string;
  tabId: string;
  url: string;
  filledAt: string;
}

/** Next to the run's browser state file (`browser-state.ts`). */
export function vaultCapturePath(browserStatePath: string): string {
  return `${browserStatePath.replace(/\.json$/, "")}.vault.json`;
}

export const VAULT_CAPTURE_NOTICE =
  "[Deskmates host notice] A Vault credential was filled on this page, so field values, images and page-code output are withheld until the tab leaves it (ADR-0045).";
export const VAULT_CAPTURE_SKIPPED =
  "Screenshot suppressed: a Vault credential was filled on this page (ADR-0045)";

/** Browser tools whose output is whatever page code returns: withheld whole while marked. */
const PAGE_CODE_TOOLS = new Set([
  "browser_evaluate",
  "browser_run_code",
  "browser_run_code_unsafe",
]);

/** `- textbox "Email" [ref=e3]: alice@example.test` keeps its label, loses its value. */
const FIELD_VALUE = /^(\s*-\s*(?:textbox|searchbox|combobox|spinbutton)\b[^\n]*?):\s+\S[^\n]*$/gm;

export function maskSnapshotText(text: string): string {
  return text.replace(FIELD_VALUE, "$1: [value hidden after a Vault fill]");
}

function bare(toolName: string): string {
  const parts = toolName.split("__");
  return parts[parts.length - 1] ?? toolName;
}

/** The result a browser tool returns while its tab carries a fill mark. */
export function maskCredentialResult(toolName: string, result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  if (PAGE_CODE_TOOLS.has(bare(toolName)))
    return { ...record, content: [{ type: "text", text: VAULT_CAPTURE_NOTICE }] };
  let noticed = false;
  const masked = content.map((item: unknown) => {
    const block = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    if (block.type === "text" && typeof block.text === "string")
      return { ...block, text: maskSnapshotText(block.text) };
    if (block.type === "image") {
      noticed = true;
      return { type: "text", text: VAULT_CAPTURE_NOTICE };
    }
    return item;
  });
  return {
    ...record,
    content: noticed ? masked : [...masked, { type: "text", text: VAULT_CAPTURE_NOTICE }],
  };
}

function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = "";
    y.hash = "";
    return x.toString() === y.toString();
  } catch {
    return a === b;
  }
}

/** What the proxy asks before it forwards a result or takes a capture. */
export interface VaultCaptureGuard {
  /** `page` is the run's current tab as the coordinator last verified it; absent is unknown. */
  active(page?: { tabId: string; url: string }): Promise<boolean>;
}

/**
 * The guard over the mark file. Unknown page: masked while the mark exists, the safe side. A page
 * other than the marked one ends the mark and deletes the file.
 */
export function fileVaultCaptureGuard(path: string): VaultCaptureGuard {
  return {
    async active(page) {
      let mark: VaultCaptureMark;
      try {
        mark = JSON.parse(await readFile(path, "utf8")) as VaultCaptureMark;
      } catch {
        return false;
      }
      if (mark?.version !== 1) return false;
      if (page && (page.tabId !== mark.tabId || !samePage(page.url, mark.url))) {
        await rm(path, { force: true }).catch(() => {});
        return false;
      }
      return true;
    },
  };
}

/** Written by the run when a fill may have put a value on the page. */
export async function writeVaultCaptureMark(
  path: string,
  mark: Omit<VaultCaptureMark, "version">,
  write: (path: string, text: string) => Promise<void> = (p, t) => writeFile(p, t),
): Promise<void> {
  await write(path, JSON.stringify({ version: 1, ...mark }));
}
