import { describe, expect, it } from "vitest";
import { SUMMARY_INSTRUCTION, parseRunSummary } from "./summary.js";

describe("parseRunSummary: skills a consolidation reports (ADR-0015 decision 2)", () => {
  it("keeps well-formed skills and leaves the key out when there are none", () => {
    const block = (skills: unknown) =>
      `\`\`\`json\n${JSON.stringify({ done: "d", reply: "", skills })}\n\`\`\``;
    const parsed = parseRunSummary(
      block([
        { name: " export-refunds ", description: "Export refunds.", body: "1. Export." },
        { name: "no-body", description: "x", body: "  " },
        { name: 7, description: "x", body: "y" },
      ]),
    ).summary;
    expect(parsed.skills).toEqual([
      { name: "export-refunds", description: "Export refunds.", body: "1. Export." },
    ]);
    expect(parseRunSummary(block([])).summary).not.toHaveProperty("skills");
    expect(parseRunSummary(block(undefined)).summary).not.toHaveProperty("skills");
  });
});

describe("parseRunSummary", () => {
  it("parses the trailing json block into a RunSummary", () => {
    const text = [
      "All done.",
      "```json",
      '{"done": "Filed the ticket", "filesChanged": ["/work/a.md"], "sitesVisited": ["ops.example.test"],',
      '"pendingApprovals": [], "memorySuggestions": ["Always check the queue first"], "reply": "Ticket filed."}',
      "```",
    ].join("\n");
    const { summary, parsed } = parseRunSummary(text);
    expect(parsed).toBe(true);
    expect(summary).toEqual({
      done: "Filed the ticket",
      filesChanged: ["/work/a.md"],
      sitesVisited: ["ops.example.test"],
      pendingApprovals: [],
      memorySuggestions: ["Always check the queue first"],
      learned: [],
      reply: "Ticket filed.",
    });
  });

  it("keeps an empty reply so the Gateway can record the run as silent", () => {
    const { summary } = parseRunSummary('```json\n{"done": "watched", "reply": ""}\n```');
    expect(summary.reply).toBe("");
    expect(summary.filesChanged).toEqual([]);
  });

  it("synthesises a summary from the final text when the block is missing", () => {
    const { summary, parsed } = parseRunSummary("Here is my answer.");
    expect(parsed).toBe(false);
    expect(summary).toEqual({
      done: "",
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
      learned: [],
      reply: "Here is my answer.",
    });
  });

  it("falls back to the last assistant text when the final text is empty or broken", () => {
    expect(parseRunSummary("", "last words").summary.reply).toBe("last words");
    const broken = parseRunSummary("```json\n{not json\n```", "fallback");
    expect(broken.parsed).toBe(false);
    expect(broken.summary.reply).toBe("fallback");
  });

  it("uses the text outside the block as reply when the block omits it", () => {
    const { summary } = parseRunSummary('Posted.\n```json\n{"done": "x"}\n```');
    expect(summary.reply).toBe("Posted.");
  });

  it("honours an explicit empty reply even when the model wrote prose before the block", () => {
    const text =
      'Nothing addressed to me; remaining silent.\n\n```json\n{"done": "observed only", "reply": ""}\n```';
    const { summary, parsed } = parseRunSummary(text);
    expect(parsed).toBe(true);
    expect(summary.done).toBe("observed only");
    expect(summary.reply).toBe("");
  });

  it("honours an explicit empty reply in a bare trailing summary object", () => {
    const text =
      'No action needed.\n\n{"done": "Observed", "filesChanged": [], "sitesVisited": ["host.docker.internal:4477"], "pendingApprovals": [], "memorySuggestions": [], "reply": ""}';
    const { summary, parsed } = parseRunSummary(text);
    expect(parsed).toBe(true);
    expect(summary.sitesVisited).toEqual(["host.docker.internal:4477"]);
    expect(summary.reply).toBe("");
  });

  it("does not mistake an object in the prose for the summary", () => {
    const { summary, parsed } = parseRunSummary(
      'The API returned {"done": true, "reply": 1} and then more text.',
    );
    expect(parsed).toBe(false);
    expect(summary.reply).toContain("more text");
  });

  it('finds the trailing summary even when earlier prose contains a {"done"…} object', () => {
    const text =
      'The API returned {"done": true, "reply": 1} and later.\n\n{"done": "Checked the API", "filesChanged": [], "sitesVisited": [], "pendingApprovals": [], "memorySuggestions": [], "reply": "final"}';
    const { summary, parsed } = parseRunSummary(text);
    expect(parsed).toBe(true);
    expect(summary.done).toBe("Checked the API");
    expect(summary.reply).toBe("final");
  });

  it("stays fast on 14 KiB of unclosed summary-looking fragments", () => {
    const text = `${'{"done": "reply": '.repeat(800)}x`;
    expect(text.length).toBeGreaterThan(14 * 1024);
    const started = performance.now();
    const { parsed } = parseRunSummary(text);
    expect(performance.now() - started).toBeLessThan(20);
    expect(parsed).toBe(false);
  });

  it("stays fast on a long message that ends with a brace but holds no summary", () => {
    const text = `${"{ ".repeat(20_000)}}`;
    const started = performance.now();
    parseRunSummary(text);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

// Observed on Testbox, 2026-09-28 (GLM 5.3, Chinese research answers): 3 of 8 bot messages in
// one round quoted words with bare ASCII quotes inside the summary strings. JSON.parse failed and
// the whole raw block was published to the thread in place of the answer.
describe("parseRunSummary with unescaped quotes inside the strings", () => {
  const broken = [
    '{"done": "完成了"最省钱"方案分析", "filesChanged": [], "sitesVisited": ["aws.amazon.com"],',
    '"pendingApprovals": [], "memorySuggestions": ["直接标注"未核实""],',
    '"reply": "@team_chief 【最省钱方案】单价"基于已有知识，未在线核实"。\\n\\n(a) 方案：S3 + Athena。"}',
  ].join(" ");

  it("reads a block whose fence shares its line with the object", () => {
    const { summary, parsed } = parseRunSummary(
      '```json {"done": "checked the labels", "reply": "All labels verified."} ```',
    );
    expect(parsed).toBe(true);
    expect(summary.reply).toBe("All labels verified.");
    expect(summary.done).toBe("checked the labels");
  });

  it("recovers the reply and done from a fenced block", () => {
    const { summary, parsed } = parseRunSummary(`\`\`\`json\n${broken}\n\`\`\``, "fallback");
    expect(parsed).toBe(false);
    expect(summary.reply).toBe(
      '@team_chief 【最省钱方案】单价"基于已有知识，未在线核实"。\n\n(a) 方案：S3 + Athena。',
    );
    expect(summary.done).toBe('完成了"最省钱"方案分析');
  });

  it("recovers the reply from a bare trailing object with no fence", () => {
    const { summary } = parseRunSummary(broken, "fallback");
    expect(summary.reply.startsWith("@team_chief 【最省钱方案】")).toBe(true);
    expect(summary.reply).not.toContain('"reply"');
  });

  it("stops the reply at the next summary key when reply is not the last one", () => {
    const text =
      '```json\n{"reply": "看"这里"就好", "done": "说了"一句"", "memorySuggestions": []}\n```';
    const { summary } = parseRunSummary(text);
    expect(summary.reply).toBe('看"这里"就好');
    expect(summary.done).toBe('说了"一句"');
  });

  it("recovers from an unclosed fence and a stray closing brace", () => {
    // The chief's report in the same round: an opening fence only, then `"}\n}`.
    const text = '```json\n{"done": "写了"总结"","reply":"@web 报告：\\n1. 结论"}\n}';
    expect(parseRunSummary(text, text).summary.reply).toBe("@web 报告：\n1. 结论");
  });

  it("keeps a recovered empty reply silent", () => {
    const { summary } = parseRunSummary('```json\n{"done": "看了"总结"", "reply": ""}\n```', "x");
    expect(summary.reply).toBe("");
  });

  it("falls back to the whole text when there is no reply key to recover", () => {
    // run-once passes the final assistant text as the fallback.
    const text = '```json\n{"done": "broken "quote" only"}\n```';
    expect(parseRunSummary(text, text).summary.reply).toBe(text);
  });
});

// ADR-0011 Verification row 2 (T0 half): the summary carries learned items with a proposed
// scope, authority and turn; malformed items are dropped and a model-written trust is ignored,
// because trust is the sidecar's to set (`memory-taint.ts`).
describe("parseRunSummary learned items", () => {
  const block = (learned: unknown) =>
    `\`\`\`json\n${JSON.stringify({ done: "d", reply: "r", learned })}\n\`\`\``;

  it("parses task, workspace and bot items", () => {
    const { summary } = parseRunSummary(
      block([
        { body: "Three rows remain.", scope: "task", authority: "fact", turn: 2 },
        { body: "case_id is at most 12 chars.", scope: "workspace", authority: "fact", turn: 3 },
        { body: "Export before closing.", proposedScope: "bot", authority: "procedure", turn: 4 },
      ]),
    );
    expect(summary.learned).toEqual([
      { body: "Three rows remain.", proposedScope: "task", authority: "fact", turn: 2 },
      {
        body: "case_id is at most 12 chars.",
        proposedScope: "workspace",
        authority: "fact",
        turn: 3,
      },
      { body: "Export before closing.", proposedScope: "bot", authority: "procedure", turn: 4 },
    ]);
  });

  it("drops a model-claimed trust and malformed items, and defaults a missing authority", () => {
    const { summary } = parseRunSummary(
      block([
        { body: "Fact.", scope: "workspace", turn: 1, trust: "trusted", sourceKind: "human" },
        { body: "", scope: "workspace", turn: 1 },
        { body: "No scope." },
        { body: "Bad scope.", scope: "global", turn: 1 },
        { body: "Rule attempt.", scope: "rule", authority: "instruction", turn: 1 },
        "just a string",
      ]),
    );
    expect(summary.learned).toEqual([
      { body: "Fact.", proposedScope: "workspace", authority: "fact", turn: 1 },
      { body: "Rule attempt.", proposedScope: "rule", authority: "fact", turn: 1 },
    ]);
  });

  it("asks for learned items in the instruction", () => {
    expect(SUMMARY_INSTRUCTION).toContain('"learned"');
    expect(SUMMARY_INSTRUCTION).toContain("task|workspace|bot");
  });
});
