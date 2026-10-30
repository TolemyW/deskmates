// Explicit synthetic fixture preparation ONLY. The subsequent periodic sweep and model job
// run through the real Gateway. This is not natural ageing or a 24-hour soak test.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.realpathSync(process.argv[2]);
assert.match(root, /^\/home\/[^/]+\/agent_workspace\/[a-z][a-z0-9-]*-reusable-[a-z0-9-]+$/);
const receipt = path.join(root, "evidence-policy-fixture.json");
assert.ok(!fs.existsSync(receipt), "preserve an existing fixture; do not reseed");
const load = (relative) => import(pathToFileURL(path.join(root, "source", relative)).href);
const { default: Database } = await load("node_modules/better-sqlite3/lib/index.js");
const { MemoryEntryStore } = await load("packages/gateway/dist/memory/entries.js");
const { ThreadStore } = await load("packages/gateway/dist/threads/threads.js");
const { MessageStore } = await load("packages/gateway/dist/threads/messages.js");
const state = JSON.parse(fs.readFileSync(path.join(root, "strict-state.json"), "utf8"));
const workspaceId = state.workspace.id;
const botId = state.bot.id;
const db = new Database(path.join(root, "data/gateway.sqlite"));
db.pragma("foreign_keys = ON");
const entries = new MemoryEntryStore(db);
const threads = new ThreadStore(db);
const messages = new MessageStore(db);
const observedAt = new Date(Date.now() - 2 * 86400000).toISOString();
const now = new Date().toISOString();
const cases = [
  { key: "unsupported", body: "Synthetic fixture: Cedar order quota is 12." },
  { key: "supported", body: "Synthetic fixture: Cedar weekly net order target is 220." },
  { key: "contradicted", body: "Synthetic fixture: Cedar ledger host is old-ledger.example.test." },
].map((c) => ({
  ...c,
  entry: entries.insert({ workspaceId, scope: "workspace", kind: "note", body: c.body,
    authority: "fact", trust: "trusted", sourceKind: "human", observedAt,
    effectiveAt: observedAt, by: "fixture:goal-first-evidence" }),
}));
const shared = threads.create({ workspaceId, botIds: [botId], title: "Synthetic current evidence" });
const sources = [
  "Synthetic current evidence: Cedar weekly net order target is 220.",
  "Synthetic current evidence: Cedar ledger host moved to new-ledger.example.test today; old-ledger.example.test is no longer used.",
].map((body) => messages.append({ threadId: shared.id, authorKind: "human", authorId: "fixture_evidence_author", body }));
const privateUser = `fixture_private_${workspaceId}`;
db.prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)")
  .run(privateUser, "Synthetic private source", now, now);
const secret = threads.create({ workspaceId, botIds: [botId], title: "Private canary excluded" });
db.prepare("UPDATE threads SET private_to_user_id = ? WHERE id = ?").run(privateUser, secret.id);
messages.append({ threadId: secret.id, authorKind: "human", authorId: privateUser,
  body: "PRIVATE_CANARY_CEDAR_12: Cedar order quota is 12." });
const result = { fixtureOnly: true, observedAt, createdAt: now, workspaceId, cases, sources,
  privateThreadId: secret.id,
  limitations: "Seeded aged notes and inert messages bypass routing for fixture setup only; the real periodic sweep and model job decide the outcomes." };
fs.writeFileSync(receipt, JSON.stringify(result, null, 2));
db.close();
console.log(JSON.stringify({ workspaceId, seededNotes: cases.length, sharedSources: sources.length }));
