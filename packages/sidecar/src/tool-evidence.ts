// Ledger-only projection. The model-facing MCP result and its untrusted wrapper are unchanged.
import type { ToolEvidenceReference } from "@deskmates/contracts";
import { redactText } from "./redact.js";

export const TOOL_RESULT_MAX_CHARS = 4000;
const CUT = "\n[truncated: section budget]";
function bounded(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - CUT.length) + CUT;
}

export type { ToolEvidenceReference };
export type SaveToolEvidence = (text: string) => Promise<ToolEvidenceReference>;

/** Prioritize current-page evidence independently of tab inventory / console / code prefixes. */
export function toolResultExcerpt(text: string, browser: boolean): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  if (!browser) return bounded(text, TOOL_RESULT_MAX_CHARS);
  // Only split exact MCP headings; malformed output keeps an explicitly incomplete fallback.
  const wrapper = /^(<untrusted source="[^"\n]*">)\n([\s\S]*)\n<\/untrusted>$/.exec(text);
  const sections = (wrapper?.[2] ?? text).split(/(?=^### )/m);
  const evidence: string[] = [];
  const metadata: string[] = [];
  for (const section of sections) {
    if (/^### Result\n\{"tabs":\[/.test(section)) {
      // The pinned host identity shim is metadata, even though MCP labels it Result.
      // Keep the current stable identity visible; retain the entire list in the artifact.
      try {
        const tabs: unknown = JSON.parse(section.split("\n")[1] ?? "").tabs;
        if (Array.isArray(tabs)) {
          const current = tabs.find((tab) => tab && tab.current === true);
          if (current) evidence.push(`### Current tab\n${bounded(JSON.stringify(current), 400)}\n`);
        }
      } catch {
        /* Malformed metadata stays explicitly incomplete in the artifact. */
      }
      metadata.push(section);
    } else if (
      /^### (?:Open tabs|Tabs|Ran Playwright code|Events|Console|Log)(?:\r?\n|$)/.test(section)
    )
      metadata.push(section);
    else evidence.push(section);
  }
  const notice =
    "[Incomplete ledger excerpt: page/result budget 3200 chars; metadata budget 600 chars. Full-result reference recorded separately.]\n";
  if (wrapper?.[1] && wrapper[1].length > 150) return bounded(text, TOOL_RESULT_MAX_CHARS);
  const opening = wrapper?.[1];
  const overhead = notice.length + (opening?.length ?? 0) + 20;
  const pageBudget = Math.min(3200, Math.max(0, TOOL_RESULT_MAX_CHARS - overhead - 601));
  const excerpt = `${bounded(evidence.join(""), pageBudget)}\n${bounded(metadata.join(""), 600)}`;
  return bounded(
    `${notice}${wrapper ? `${wrapper[1]}\n${excerpt}\n</untrusted>` : excerpt}`,
    TOOL_RESULT_MAX_CHARS,
  );
}

export async function ledgerToolResult(
  text: string,
  browser: boolean,
  secrets: readonly string[],
  save?: SaveToolEvidence,
): Promise<Record<string, unknown>> {
  // Redact BEFORE slicing: a credential spanning a budget boundary must not leak a prefix.
  const redacted = redactText(text, secrets);
  const content = toolResultExcerpt(redacted, browser);
  if (redacted.length <= TOOL_RESULT_MAX_CHARS) return { content };
  const result: Record<string, unknown> = {
    content,
    truncated: true,
    originalChars: redacted.length,
    excerptBudgetChars: TOOL_RESULT_MAX_CHARS,
    truncationReason: browser ? "page-and-metadata-budgets" : "ledger-excerpt-budget",
  };
  if (!browser) return result;
  try {
    result.evidence = save ? await save(redacted) : { unavailable: "evidence storage unavailable" };
  } catch {
    result.evidence = { unavailable: "evidence storage failed or busy; excerpt is incomplete" };
  }
  return result;
}
