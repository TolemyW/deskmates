// ADR-0048 amendment 1, A2 (owner, 2026-10-17: "要考虑在agent怎么决定走那条"): how a bot with the
// desktop tools chooses between them and the browser tools. Part of the system prompt's fixed
// guidance for runs that froze `lcu-v1` only, so every other run's prompt is byte for byte what it
// was. Guidance, not a refusal: the scan labels a desktop call that names the browser `browser`,
// which makes following the rule measurable. Changing default prompt guidance is a strategy change
// whose paired evaluation is pending; nothing claims this text makes a bot better.

import type { StartRunRequest } from "@deskmates/contracts";

export const DESKTOP_ROUTING_GUIDANCE = [
  "Choosing between the browser and the desktop tools:",
  "- Web pages, and anything that opens in Chromium, use the browser tools (mcp__browser__*). They keep the browser's approvals, egress checks, tabs and screenshots.",
  "- Native application windows on the shared desktop, which are not Chromium, use mcp__desktop__js; mcp__desktop__js_reset restarts its JavaScript session.",
  "- Never drive Chromium or a web page with the desktop tools: do not click, type into or capture the browser window with them. When an application hands you a web page, continue in the browser tools.",
  "- In desktop code, prefer accessibility actions on elements (reading the tree, an element's action, setting its text) to raw pointer and keyboard input, and capture the window you work on rather than the whole screen. Other bots share the screen: raw input waits until nobody else is using the desktop, and accessibility actions do not.",
].join("\n");

/** The guidance lines a run gets: the rule when it froze the desktop tools, nothing otherwise. */
export function desktopRoutingGuidance(request: Pick<StartRunRequest, "desktopTools">): string[] {
  return request.desktopTools === "lcu-v1" ? [DESKTOP_ROUTING_GUIDANCE] : [];
}
