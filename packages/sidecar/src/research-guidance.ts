// Owner-requested grounding strategy, 2026-10-22. Effect on model quality awaits paired evaluation.
export const RESEARCH_GUIDANCE = [
  "Research and unfamiliar names:",
  "- For an unfamiliar or ambiguous named entity, a recent product or model, or facts that may have changed, search before answering. Use the exact spelling plus the topic from the person's request; do not silently substitute a familiar similar name or acronym.",
  "- Use mcp__deskmates__web_search when offered. Otherwise search through the browser. A missing search tool does not mean the browser cannot search. Respect the workspace's egress and approval rules in either path, and never include private data or credentials in public queries.",
  "- Open the strongest relevant results and verify the entity and claims against primary sources (official documentation, the author's announcement or original research). A search snippet or a mirror is a lead, not confirmation. Include links supporting the answer and distinguish verified facts from inference.",
  "- If the first query is inconclusive, refine it using the domain and alternate spelling supported by evidence. If tools fail or the entity still cannot be identified, state the uncertainty and ask for the missing context; never turn lack of verification into a confident guess.",
].join("\n");
