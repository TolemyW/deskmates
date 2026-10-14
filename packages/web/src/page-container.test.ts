// T0 layout contract for issue #49. Menu pages share one centered frame; split/full-width views
// stay explicit exceptions instead of inheriting an accidental max width.

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

it("defines one responsive centered page container and applies it to menu pages", () => {
  const css = source("./design-refresh.css");
  expect(css).toMatch(/\.page-container\.page-container\s*\{[^}]*max-width:\s*1120px/s);
  expect(css).toMatch(/\.page-container\.page-container\s*\{[^}]*margin-inline:\s*auto/s);
  expect(css).toMatch(/\.page-container--narrow\.page-container\s*\{[^}]*max-width:\s*760px/s);

  for (const file of [
    "./features/members/members.tsx",
    "./features/costs/costs.tsx",
    "./features/integrations/integrations.tsx",
    "./features/computer/computer.tsx",
    "./features/skills/skills.tsx",
    "./features/knowledge/knowledge-page.tsx",
    "./features/account/account-settings.tsx",
    "./features/tasks/tasks.tsx",
    "./features/approvals/approvals.tsx",
    "./features/contacts/desktops.tsx",
    "./components/resource-page.tsx",
  ]) {
    expect(source(file), file).toContain("page-container");
  }
});

it("leaves split and detail-heavy screens full width", () => {
  for (const file of [
    "./features/chats/thread.tsx",
    "./features/contacts/contacts.tsx",
    "./features/files/files.tsx",
  ]) {
    expect(source(file), file).not.toContain("page-container");
  }
});
