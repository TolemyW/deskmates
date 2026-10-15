// T0, ADR-0002 amendment 4 B3 as amendment 6 D3 narrowed it: what automatic review never decides.

import type { Approval, ApprovalId, BotId, RunId, ToolAction } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { reviewIneligibility } from "./auto-review-policy.js";

function approval(
  action: Partial<ToolAction> & { toolName: string },
  extra: Partial<Approval> = {},
) {
  return {
    id: "a1" as ApprovalId,
    runId: "r1" as RunId,
    botId: "b1" as BotId,
    action: { input: {}, ...action },
    riskLevel: "L2",
    waitMode: "live",
    createdAt: "2026-10-14T00:00:00.000Z",
    kind: "tool",
    ...extra,
  } as Approval;
}

const bash = (command: string) => approval({ toolName: "Bash", input: { command } });
const clean = { scrubbedSecrets: false };

describe("reviewIneligibility", () => {
  it("lets a routine requested shell action through to review", () => {
    for (const command of [
      "git push origin feature/x",
      "curl -X POST https://api.example.com/upload -F file=@report.pdf",
      "gh pr comment 12 --body 'done'",
      "npm publish --dry-run",
    ])
      expect(reviewIneligibility(bash(command), clean), command).toBeUndefined();
  });

  it("keeps permanent deletion with a human", () => {
    for (const command of [
      "rm -rf build",
      "cd x && rm a.txt",
      "find . -name '*.log' -delete",
      "git clean -fdx",
      "git reset --hard HEAD~1",
      "git branch -D old",
      "git push --force origin main",
      "git push -f origin main",
      "git push origin --delete feature",
      "git push origin :feature",
      "psql -c 'DELETE FROM users'",
      "sqlite3 db 'drop table runs'",
      "echo x | shred -u secret",
    ])
      expect(reviewIneligibility(bash(command), clean), command).toBe("deletion");
    expect(
      reviewIneligibility(approval({ toolName: "db_query", sqlStatementKind: "ddl" }), clean),
    ).toBe("deletion");
  });

  it("keeps permission expansion with a human", () => {
    for (const command of [
      "sudo apt-get install x",
      "chmod 777 /work",
      "chown root file",
      "echo key >> ~/.ssh/authorized_keys",
      "usermod -aG docker bot",
    ])
      expect(reviewIneligibility(bash(command), clean), command).toBe("permission");
  });

  it("reviews browser actions since amendment 6 (D3)", () => {
    expect(
      reviewIneligibility(approval({ toolName: "mcp__browser__browser_click" }), clean),
    ).toBeUndefined();
    expect(reviewIneligibility(bash("playwright-cli click e12"), clean)).toBeUndefined();
    // A browser action that deletes is still a deletion.
    expect(reviewIneligibility(bash("playwright-cli eval x && rm -rf /work/out"), clean)).toBe(
      "deletion",
    );
  });

  it("never reviews egress, continuations, unclassified tools or credentials", () => {
    expect(reviewIneligibility(approval({ toolName: "Bash" }, { kind: "egress" }), clean)).toBe(
      "egress",
    );
    expect(
      reviewIneligibility(
        approval({ toolName: "__run_continuation__" }, { kind: "continuation" }),
        clean,
      ),
    ).toBe("continuation");
    expect(
      reviewIneligibility(approval({ toolName: "NewSdkTool", unclassified: true }), clean),
    ).toBe("unclassified");
    expect(reviewIneligibility(bash("git push origin dev"), { scrubbedSecrets: true })).toBe(
      "credential",
    );
  });
});
