// Every message fragment (issue #53), one line per owner, sorted by path. A new feature with its
// own strings adds its `messages/index.ts` here; `catalogs.ts` assembles the catalogs from this
// list and `message-fragments.test.ts` fails on a fragment directory missing from it.

export { appMessages } from "../app/messages/index.js";
export { accountMessages } from "../features/account/messages/index.js";
export { analyticsMessages } from "../features/analytics/messages/index.js";
export { appSharesMessages } from "../features/app-shares/messages/index.js";
export { approvalsMessages } from "../features/approvals/messages/index.js";
export { boardMessages } from "../features/board/messages/index.js";
export { chatsMessages } from "../features/chats/messages/index.js";
export { computerMessages } from "../features/computer/messages/index.js";
export { contactsMessages } from "../features/contacts/messages/index.js";
export { costsMessages } from "../features/costs/messages/index.js";
export { desktopToolsMessages } from "../features/desktop-tools/messages/index.js";
export { filesMessages } from "../features/files/messages/index.js";
export { integrationsMessages } from "../features/integrations/messages/index.js";
export { knowledgeMessages } from "../features/knowledge/messages/index.js";
export { limitsMessages } from "../features/limits/messages/index.js";
export { membersMessages } from "../features/members/messages/index.js";
export { networkMessages } from "../features/network/messages/index.js";
export { runStatsMessages } from "../features/run-stats/messages/index.js";
export { runsMessages } from "../features/runs/messages/index.js";
export { skillsMessages } from "../features/skills/messages/index.js";
export { taskKindsMessages } from "../features/task-kinds/messages/index.js";
export { tasksMessages } from "../features/tasks/messages/index.js";
export { trashMessages } from "../features/trash/messages/index.js";
export { vaultMessages } from "../features/vault/messages/index.js";
export { webSearchMessages } from "../features/web-search/messages/index.js";
export { workdirMessages } from "../features/workdir/messages/index.js";
export { workspacesMessages } from "../features/workspaces/messages/index.js";
export { commonMessages } from "./common/index.js";
