import { describe, expect, it } from "vitest";
import {
  SDK_BUILTIN_TOOLS,
  classifyTool,
  isBrowserTool,
  isConnectorSubmit,
  isIntegrationExecute,
  isNavigation,
  isNavigationTool,
  riskTier,
  sideEffectPhrase,
  splitMcpToolName,
} from "./risk-tier.js";

describe("sideEffectPhrase: the stable part of an L2 click (ADR-0002 amendment 2, A3)", () => {
  it("returns the phrase that made the click L2, lower-cased", () => {
    expect(sideEffectPhrase({ element: "Submit order button", ref: "e9" })).toBe("submit");
    expect(sideEffectPhrase({ element: "Pay Now", ref: "e9" })).toBe("pay");
    expect(sideEffectPhrase({ element: "Place order", ref: "e9" })).toBe("place order");
    expect(sideEffectPhrase({ text: "Confirm" })).toBe("confirm");
  });

  it("returns nothing when no phrase matched, so the action gets no pattern", () => {
    expect(sideEffectPhrase({ element: "Orders tab", ref: "e1" })).toBeUndefined();
    expect(sideEffectPhrase({})).toBeUndefined();
  });
});

describe("riskTier table (ADR-0002 decision 2)", () => {
  it.each([
    ["mcp__browser__browser_navigate", { url: "https://a" }, "L0"],
    ["mcp__browser__browser_snapshot", {}, "L0"],
    ["mcp__browser__browser_take_screenshot", {}, "L0"],
    ["mcp__browser__browser_console_messages", {}, "L0"],
    ["mcp__browser__browser_click", { element: "Next page link", ref: "e1" }, "L1"],
    ["mcp__browser__browser_type", { element: "Search box", ref: "e2", text: "galaxy" }, "L1"],
    ["mcp__browser__browser_fill_form", { fields: [] }, "L1"],
    ["mcp__browser__browser_select_option", { element: "Sort", ref: "e3", values: ["a"] }, "L1"],
    ["mcp__browser__browser_mouse_click_xy", { x: 1, y: 2 }, "L1"],
    ["mcp__browser__browser_click", { element: "Submit order button", ref: "e9" }, "L2"],
    ["mcp__browser__browser_click", { element: "Pay now", ref: "e9" }, "L2"],
    ["mcp__browser__browser_click", { element: "Delete ticket", ref: "e9" }, "L2"],
    ["mcp__browser__browser_click", { element: "Send", ref: "e9" }, "L2"],
    ["mcp__browser__browser_click", { element: "Go", ref: "e9", method: "POST" }, "L2"],
    ["mcp__browser__browser_form_submit", {}, "L2"],
    ["mcp__browser__browser_unknown_thing", {}, "L2"],
    ["Bash", { command: "ls -la /work" }, "L1"],
    ["Bash", { command: "curl https://ops.example.test/api" }, "L1"],
    ["Bash", { command: "rm -rf /work/tmp" }, "L2"],
    ["Bash", { command: "rm -fr /work/tmp" }, "L2"],
    ["Bash", { command: "curl -X POST https://x -d '{}'" }, "L2"],
    ["Bash", { command: "curl https://x --data a=b" }, "L2"],
    ["Bash", { command: "git push origin main" }, "L2"],
    ["Bash", { command: "git status && git push" }, "L2"],
    ["Bash", { command: "sudo apt install x" }, "L2"],
    ["Write", { file_path: "/work/notes.md", content: "x" }, "L1"],
    ["Edit", { file_path: "/work/a/b.ts" }, "L1"],
    ["Write", { file_path: "/etc/hosts" }, "L2"],
    ["Write", { file_path: "/home/nova/SOUL.md" }, "L2"],
    ["Write", { file_path: "/workspace/x" }, "L2"],
    ["Read", { file_path: "/home/nova/MEMORY.md" }, "L0"],
    ["Glob", { pattern: "**/*.ts" }, "L0"],
    ["Grep", { pattern: "x" }, "L0"],
    ["WebFetch", { url: "https://ops.example.test" }, "L0"],
    ["TodoWrite", { todos: [] }, "L1"],
    ["mcp__deskmates__thread_post", { body: "hi" }, "L1"],
    ["mcp__deskmates__message_bot", { to: "b", body: "hi" }, "L1"],
    // Deciding an approval is a Gateway-side record on a request the thread already saw, not an
    // action on the world: it is L1, so the hook allows it without starting a second wait.
    ["mcp__deskmates__approval_decide", { approvalId: "ap-1", decision: "allow_once" }, "L1"],
    // A Gateway-side record that a human still accepts (ADR-0021 amendment 2), not an act on the world.
    ["mcp__deskmates__task_deliver", { taskId: "task_1", summary: "done", artifacts: [] }, "L1"],
    ["SendEmail", {}, "L2"],
    ["mcp__crm__delete_record", { id: 1 }, "L2"],
    ["mcp__payments__purchase", {}, "L2"],
    ["mcp__db__query", { sql: "select 1" }, "L2"],
    // ADR-0002 amendment 3, A5: a subagent spawn is L1, because every call inside it passes the
    // hook with `agent_id` set. Was L2 by the unknown-tool fallback before the amendment.
    ["Task", { prompt: "x" }, "L1"],
    ["SomethingNew", {}, "L2"],
  ] as const)("%s %j -> %s", (name, input, expected) => {
    expect(riskTier(name, input as Record<string, unknown>)).toBe(expected);
  });

  it("is pure: the same call always yields the same tier", () => {
    const input = { command: "git push" };
    expect(riskTier("Bash", input)).toBe(riskTier("Bash", input));
  });
});

describe("riskTier shell classification is by argv, not by regex (review item 1)", () => {
  it.each([
    // curl: combined short flags, quoted or attached method, --json, & inside a quoted URL.
    ["curl -sSd 'x=1' https://ops.example.test/api", "L2"],
    ['curl -X "POST" https://ops.example.test/api', "L2"],
    ["curl -XPOST https://ops.example.test/api", "L2"],
    ["curl -X post https://ops.example.test/api", "L2"],
    ["curl --request=DELETE https://ops.example.test/api/1", "L2"],
    ["curl --json '{}' https://ops.example.test/api", "L2"],
    ["curl 'https://ops.example.test/api?a=1&b=2' -X POST -d x", "L2"],
    ["curl https://ops.example.test/x -F file=@/work/a", "L2"],
    ["curl -T /work/a https://ops.example.test/up", "L2"],
    ["curl --data-binary @/work/a https://ops.example.test/up", "L2"],
    ["curl -K /work/request.curl https://ops.example.test/x", "L2"],
    ["curl -K/work/request.curl https://ops.example.test/x", "L2"],
    ["curl -sK/work/request.curl https://ops.example.test/x", "L2"],
    ["curl --config /work/request.curl https://ops.example.test/x", "L2"],
    ["curl --config=/work/request.curl https://ops.example.test/x", "L2"],
    ["curl --config - https://ops.example.test/x", "L2"],
    ["curl -sS -o /tmp/x https://ops.example.test/x", "L1"],
    ["curl -X GET https://ops.example.test/x", "L1"],
    ["curl -sSL https://ops.example.test/x", "L1"],
    ["/usr/bin/curl -d x https://ops.example.test/x", "L2"],
    ["env curl -d x https://ops.example.test/x", "L2"],
    ["ls | xargs curl -X PUT", "L2"],
    ['bash -c "curl -d x https://ops.example.test/x"', "L2"],
    // wget.
    ["wget --post-data 'a=1' https://ops.example.test/x", "L2"],
    ["wget --post-file=/work/a https://ops.example.test/x", "L2"],
    ["wget --method=PUT https://ops.example.test/x", "L2"],
    ["wget --method DELETE https://ops.example.test/x", "L2"],
    ["wget -qO- https://ops.example.test/x", "L1"],
    // rm: any recursive flag, in any spelling.
    ["rm -r -f /work/x", "L2"],
    ["rm --recursive --force /work/x", "L2"],
    ["rm -R /work/x", "L2"],
    ["rm -Rf /work/x", "L2"],
    ["rm -r /work/x", "L2"],
    ["rm -f /work/x", "L1"],
    ["rm /work/x", "L1"],
    ["rm -v /work/x", "L1"],
    // git: the subcommand after global options.
    ["git -C /work push", "L2"],
    ["git -c user.name=x push origin main", "L2"],
    ["git --git-dir=/work/.git push", "L2"],
    ["git --no-pager push", "L2"],
    ["git -C /work status", "L1"],
    ["git log --oneline | grep push", "L1"],
    ["git commit -m 'push later'", "L1"],
    // The other destructive rules are unchanged.
    ["sudo ls", "L2"],
    ["mkfs.ext4 /dev/sda1", "L2"],
    ["dd if=/dev/zero of=/work/x bs=1M count=1", "L2"],
    ["shutdown -h now", "L2"],
    ["reboot", "L2"],
    // Segment operators still split, and quoting is honoured on the destructive side too.
    ["ls; rm -rf /work/x", "L2"],
    ["echo 'rm -rf /work/x'", "L1"],
    ["echo 'git push'", "L1"],
    ['echo "curl -d x https://h"', "L1"],
    ["true && $(git push)", "L2"],
    ["echo `git push`", "L2"],
  ])("Bash %j -> %s", (command, expected) => {
    expect(riskTier("Bash", { command })).toBe(expected);
  });
});

describe("riskTier normalises file paths before the /work test (review item 3)", () => {
  it.each([
    ["Write", "/work/../home/nova/SOUL.md", "L2"],
    ["Edit", "/work/../etc/cron.d/x", "L2"],
    ["Write", "/work/a/../../etc/passwd", "L2"],
    ["Write", "/work/./a/../b.md", "L1"],
    ["Write", "notes.md", "L1"],
    ["Write", "../home/nova/SOUL.md", "L2"],
    ["Write", "/work//a.md", "L1"],
    ["NotebookEdit", "/work/x.ipynb", "L1"],
    ["Write", "", "L2"],
  ])("%s %j -> %s", (tool, file_path, expected) => {
    expect(riskTier(tool, { file_path })).toBe(expected);
  });
});

describe("riskTier browser rules (review items 4 and 6)", () => {
  it("rates browser_file_upload L2 unconditionally", () => {
    expect(riskTier("mcp__browser__browser_file_upload", { paths: ["/work/a.pdf"] })).toBe("L2");
    expect(riskTier("mcp__browser__browser_file_upload", {})).toBe("L2");
  });

  it.each([
    ["Place order", "L2"],
    ["Checkout button", "L2"],
    ["Confirm transfer", "L2"],
    ["Buy now", "L2"],
    ["Publish post", "L2"],
    ["Approve request", "L2"],
    ["Transfer funds", "L2"],
    ["Submit order button", "L2"],
    ["Delete ticket", "L2"],
    ["Pay now", "L2"],
    ["Send", "L2"],
    ["Next page link", "L1"],
    ["Orders tab", "L1"],
    ["Search", "L1"],
    ["Payment history tab", "L1"],
    ["Transfers report link", "L1"],
    ["Confirmation page link", "L1"],
  ])("click on %j -> %s", (element, expected) => {
    expect(riskTier("mcp__browser__browser_click", { element, ref: "e1" })).toBe(expected);
  });
});

describe("riskTier browser table matches @playwright/mcp 0.0.82 (review L6)", () => {
  const b = (tool: string) => `mcp__browser__${tool}`;

  it.each([
    // Core automation reads.
    ["browser_snapshot", "L0"],
    ["browser_take_screenshot", "L0"],
    ["browser_console_messages", "L0"],
    ["browser_network_requests", "L0"],
    // `browser_network_request` (singular) is a real 0.0.82 tool and was missing from the table.
    ["browser_network_request", "L0"],
    ["browser_find", "L0"],
    ["browser_wait_for", "L0"],
    ["browser_hover", "L0"],
    ["browser_resize", "L0"],
    ["browser_navigate_back", "L0"],
    ["browser_tabs", "L0"],
    // Opt-in capability reads.
    ["browser_get_config", "L0"],
    ["browser_route_list", "L0"],
    ["browser_annotate", "L0"],
    ["browser_highlight", "L0"],
    ["browser_hide_highlight", "L0"],
    ["browser_pdf_save", "L0"],
    ["browser_generate_locator", "L0"],
    ["browser_verify_element_visible", "L0"],
    ["browser_verify_list_visible", "L0"],
    ["browser_verify_text_visible", "L0"],
    ["browser_verify_value", "L0"],
    // Core automation writes.
    ["browser_drop", "L1"],
    ["browser_emulate_media", "L1"],
    ["browser_handle_dialog", "L1"],
    ["browser_close", "L1"],
    ["browser_evaluate", "L1"],
    // The tool is called `browser_run_code_unsafe`; the table used to name `browser_run_code`.
    ["browser_run_code_unsafe", "L1"],
    ["browser_network_state_set", "L1"],
    // Coordinate-based (--caps=vision), the capability the sidecar enables.
    ["browser_mouse_down", "L1"],
    ["browser_mouse_up", "L1"],
    ["browser_mouse_wheel", "L1"],
    ["browser_mouse_move_xy", "L1"],
    ["browser_mouse_drag_xy", "L1"],
    // Login state and request routing always ask.
    ["browser_file_upload", "L2"],
    ["browser_cookie_get", "L2"],
    ["browser_cookie_list", "L2"],
    ["browser_cookie_set", "L2"],
    ["browser_cookie_clear", "L2"],
    ["browser_storage_state", "L2"],
    ["browser_set_storage_state", "L2"],
    ["browser_localstorage_get", "L2"],
    ["browser_localstorage_set", "L2"],
    ["browser_sessionstorage_list", "L2"],
    ["browser_route", "L2"],
    ["browser_unroute", "L2"],
  ] as const)("%s -> %s", (tool, expected) => {
    expect(riskTier(b(tool), {})).toBe(expected);
  });

  it.each([
    // Never existed in 0.0.82: a dead row promised a tier for a call that can never arrive.
    "browser_install",
    "browser_navigate_forward",
    "browser_tab_list",
    "browser_tab_select",
    "browser_tab_new",
    "browser_tab_close",
    "browser_run_code",
    // Anything a later release adds.
    "browser_something_new",
  ])("%s is not in the table, so it is L2", (tool) => {
    expect(riskTier(b(tool), {})).toBe("L2");
  });

  it("rates the vision mouse tools by their element description like any other click", () => {
    expect(riskTier(b("browser_mouse_click_xy"), { x: 1, y: 2, element: "Next page" })).toBe("L1");
    expect(riskTier(b("browser_mouse_click_xy"), { x: 1, y: 2, element: "Place order" })).toBe(
      "L2",
    );
  });
});

describe("tool name helpers", () => {
  it("splits mcp names", () => {
    expect(splitMcpToolName("mcp__browser__browser_navigate")).toEqual({
      server: "browser",
      tool: "browser_navigate",
    });
    expect(splitMcpToolName("Bash")).toEqual({ tool: "Bash" });
  });

  it("recognises browser and navigation tools", () => {
    expect(isBrowserTool("mcp__browser__browser_click")).toBe(true);
    expect(isBrowserTool("Bash")).toBe(false);
    expect(isNavigationTool("mcp__browser__browser_navigate")).toBe(true);
    expect(isNavigationTool("WebFetch")).toBe(true);
    expect(isNavigationTool("mcp__browser__browser_click")).toBe(false);
  });

  it("isNavigation covers any browser tool whose input carries a url (review item 5)", () => {
    expect(isNavigation("mcp__browser__browser_navigate", { url: "https://a" })).toBe(true);
    expect(isNavigation("mcp__browser__browser_navigate", {})).toBe(true);
    expect(isNavigation("WebFetch", { url: "https://a" })).toBe(true);
    expect(isNavigation("mcp__browser__browser_tabs", { action: "new", url: "https://a" })).toBe(
      true,
    );
    expect(isNavigation("mcp__browser__browser_tab_new", { url: "https://a" })).toBe(true);
    expect(isNavigation("mcp__browser__browser_evaluate", { url: "https://a" })).toBe(true);
    expect(isNavigation("mcp__browser__browser_tabs", { action: "list" })).toBe(false);
    expect(isNavigation("mcp__browser__browser_click", { element: "x", ref: "e1" })).toBe(false);
    // Only a top-level string url counts; nested or non-string values are not navigation.
    expect(isNavigation("mcp__browser__browser_tabs", { url: 5 })).toBe(false);
    expect(isNavigation("mcp__browser__browser_fill_form", { fields: [{ url: "x" }] })).toBe(false);
    // Non-browser tools are not widened.
    expect(isNavigation("Bash", { url: "https://a" })).toBe(false);
    expect(isNavigation("mcp__crm__lookup", { url: "https://a" })).toBe(false);
  });
});

describe("connector tools (ADR-0012 item 6)", () => {
  it("rates describe, validate, status and receipt L0", () => {
    for (const tool of ["describe", "validate", "status", "receipt"]) {
      expect(riskTier(`mcp__deskmates__connector_${tool}`, { connector: "tickets" }), tool).toBe(
        "L0",
      );
    }
  });

  it("rates submit L2 by name: the pure table cannot know the effect, the hook replaces it", () => {
    expect(isConnectorSubmit("mcp__deskmates__connector_submit")).toBe(true);
    expect(isConnectorSubmit("mcp__other__connector_submit")).toBe(false);
    // A claimed effect in the input changes nothing; only the stored validation does.
    expect(
      riskTier("mcp__deskmates__connector_submit", { connector: "tickets", effect: "read" }),
    ).toBe("L2");
  });
});

describe("integration tools (ADR-0013 item 6)", () => {
  it("rates apps, connections, search and guide L0", () => {
    for (const tool of ["apps", "connections", "search", "guide"]) {
      expect(riskTier(`mcp__deskmates__integration_${tool}`, {}), tool).toBe("L0");
    }
  });

  it("rates execute L2 by name: the pure table cannot know operationType, the hook replaces it", () => {
    expect(isIntegrationExecute("mcp__deskmates__integration_execute")).toBe(true);
    expect(isIntegrationExecute("mcp__other__integration_execute")).toBe(false);
    expect(
      riskTier("mcp__deskmates__integration_execute", {
        actionId: "slack.list_channels",
        operationType: "read",
      }),
    ).toBe("L2");
  });
});

describe("curated tier table (ADR-0002 amendment 3, A5)", () => {
  it("rates a subagent spawn L1 under both of its names", () => {
    const spawn = {
      description: "explore",
      prompt: "Read the thread code",
      subagent_type: "Explore",
    };
    expect(riskTier("Agent", spawn)).toBe("L1");
    expect(riskTier("Task", spawn)).toBe("L1");
  });

  it("rates the SDK's read-only discovery tool ListAgents L0", () => {
    expect(riskTier("ListAgents", {})).toBe("L0");
  });

  it("keeps every other pinned SDK tool at the tier it had, now on purpose", () => {
    // Not named by the amendment, so their tier does not move; they are classified, not unknown.
    for (const tool of [
      "SendMessage",
      "TaskStop",
      "EnterWorktree",
      "ExitWorktree",
      "ReportFindings",
    ])
      expect(classifyTool(tool, {})).toEqual({ level: "L2" });
    for (const tool of ["Skill", "Read", "WebFetch", "WebSearch"])
      expect(classifyTool(tool, {})).toEqual({ level: "L0" });
  });

  // The tools SDK 0.3.278's CLI declares to the model with `settingSources: []` (captured from
  // the request body sent to a loopback upstream, no model). The T2
  // `sdk-tool-inventory.container.test.ts` re-reads the list from the pinned SDK itself.
  const PINNED_SDK_TOOLS = [
    "Agent",
    "Task",
    "Bash",
    "CronCreate",
    "CronDelete",
    "CronList",
    "Edit",
    "EnterWorktree",
    "ExitWorktree",
    "ListAgents",
    "NotebookEdit",
    "Read",
    "ReportFindings",
    "ScheduleWakeup",
    "SendMessage",
    "Skill",
    "TaskStop",
    "WebFetch",
    "WebSearch",
    "Workflow",
    "Write",
  ];

  it("lists every tool of the pinned SDK", () => {
    for (const tool of PINNED_SDK_TOOLS) expect(SDK_BUILTIN_TOOLS.has(tool), tool).toBe(true);
    for (const tool of PINNED_SDK_TOOLS)
      expect(
        classifyTool(tool, { file_path: "/work/a", command: "ls" }).unclassified,
        tool,
      ).toBeUndefined();
  });

  it("labels a tool in no table unclassified, and it is still L2", () => {
    expect(classifyTool("SomethingNew", {})).toEqual({ level: "L2", unclassified: true });
    expect(classifyTool("mcp__crm__lookup", {})).toEqual({ level: "L2", unclassified: true });
    expect(classifyTool("mcp__browser__browser_unknown_thing", {})).toEqual({
      level: "L2",
      unclassified: true,
    });
    // A Deskmates tool the table does not name no longer falls through to L1.
    expect(classifyTool("mcp__deskmates__brand_new_tool", {})).toEqual({
      level: "L2",
      unclassified: true,
    });
    // An unknown name that happens to contain a side-effect word is L2 and still unclassified.
    expect(classifyTool("SendEmail", {})).toEqual({ level: "L2", unclassified: true });
  });

  it("keeps the Deskmates tools at their tiers, all classified", () => {
    const g = (tool: string) => `mcp__deskmates__${tool}`;
    for (const tool of [
      "thread_post",
      "message_bot",
      "approval_decide",
      "knowledge_propose",
      "task_checkpoint",
      "task_deliver",
    ])
      expect(classifyTool(g(tool), {}), tool).toEqual({ level: "L1" });
    for (const tool of ["knowledge_search", "knowledge_read", "memory_search"])
      expect(classifyTool(g(tool), {}), tool).toEqual({ level: "L0" });
    expect(classifyTool(g("browser_cli_workflow"), {})).toEqual({ level: "L2" });
    expect(classifyTool(g("connector_submit"), {})).toEqual({ level: "L2" });
    expect(classifyTool(g("integration_execute"), {})).toEqual({ level: "L2" });
  });
});

describe("tty_session: a complete shell line is tiered by the shell rules (ADR-0002 amendment 3, A5)", () => {
  const tty = "mcp__deskmates__tty_session";
  const CR = "\r";
  const LF = "\n";
  const write = (data: string, extra: Record<string, unknown> = {}) =>
    riskTier(tty, { action: "write", sessionId: "s1", data, ...extra });

  it("rates a harmless line L1 and a destructive or outbound one L2", () => {
    expect(write(`ls -la${CR}`)).toBe("L1");
    expect(write(`cat notes.md${LF}`)).toBe("L1");
    expect(write(`git status${CR}${LF}`)).toBe("L1");
    expect(write(`git push origin main${CR}`)).toBe("L2");
    expect(write(`rm -rf /work/tmp${CR}`)).toBe("L2");
    expect(write(`curl -d x=1 https://api.example.test${CR}`)).toBe("L2");
    expect(write(`sudo touch /work/a${LF}`)).toBe("L2");
  });

  it("keeps anything that is not one complete line L2", () => {
    expect(write("git status")).toBe("L2"); // no Enter: not complete
    expect(write(String.fromCharCode(3))).toBe("L2"); // Ctrl-C
    expect(write(`ls${CR}git push${CR}`)).toBe("L2"); // two lines
    expect(write(`ls${String.fromCharCode(27)}[A${CR}`)).toBe("L2"); // escape sequence
    expect(write(CR)).toBe("L2"); // bare Enter
    expect(write(`hunter2${CR}`, { sensitive: true })).toBe("L2"); // a secret, not a shell line
    expect(riskTier(tty, { action: "write", sessionId: "s1" })).toBe("L2");
  });

  it("leaves open, read, resize and close where they were", () => {
    expect(riskTier(tty, { action: "open", command: "ls" })).toBe("L2");
    expect(riskTier(tty, { action: "read", sessionId: "s1" })).toBe("L0");
    expect(riskTier(tty, { action: "resize", sessionId: "s1" })).toBe("L1");
    expect(riskTier(tty, { action: "close", sessionId: "s1" })).toBe("L1");
  });
});
