// Operator route policies for a bot after creation (ADR-0043): rule-file versions, the diary and
// "Run now"; aggregated in `../route-policy.ts`. Reading is a Member's, as for SOUL and MEMORY
// themselves; restoring, deleting a diary line and starting a cron entry are an Admin's.

import { type PolicyTable, admin, member } from "./policy.js";

const FILE = "file is soul or memory; versions are read only under the guarded bot";
const VERSION = `${FILE}; version is a number of that bot's own history`;
const DAY = "day is YYYY-MM-DD, read only under the guarded bot's home";

export const botConfigRoutePolicies: PolicyTable = {
  "GET /api/bots/:id/rule-versions/:file": member({ params: { id: "bot" }, handlerCheck: FILE }),
  "GET /api/bots/:id/rule-versions/:file/diff": member({
    params: { id: "bot" },
    handlerCheck: VERSION,
  }),
  "GET /api/bots/:id/rule-versions/:file/:version": member({
    params: { id: "bot" },
    handlerCheck: VERSION,
  }),
  "POST /api/bots/:id/rule-versions/:file/:version/restore": admin({
    params: { id: "bot" },
    handlerCheck: VERSION,
  }),
  "GET /api/bots/:id/diary": member({ params: { id: "bot" } }),
  "GET /api/bots/:id/diary/:day": member({ params: { id: "bot" }, handlerCheck: DAY }),
  "POST /api/bots/:id/diary/:day/delete-line": admin({ params: { id: "bot" }, handlerCheck: DAY }),
  "POST /api/bots/:id/cron/:entry/run": admin({
    params: { id: "bot" },
    handlerCheck: "entry is an index into the guarded bot's own cron list",
  }),
};
