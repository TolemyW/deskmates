// ADR-0038 decision 9: a thread's SDK session follows its bot into the bot's own directory.
//
// The SDK stores a session's transcript under the working directory it ran in:
// `$CLAUDE_CONFIG_DIR/projects/<cwd, every non-alphanumeric character replaced by '-'>/<id>.jsonl`.
// A thread whose session began in the shared `/work` (before per-bot became the default) would
// otherwise resume nothing once its runs start in `/work/bots/<bot>`. Before such a resume the
// sidecar copies the transcript to the bot directory's key. Best effort: a failure is a warning
// and the SDK behaves as it would have without the copy. The key format matches SDK 0.3.278's
// own (`replace(/[^a-zA-Z0-9]/g, "-")` under `<config dir>/projects`, read from `sdk.mjs`; keys
// above 200 characters get a hash suffix there, which bot directories never reach). Not yet
// verified in a real container.

import type { StartRunRequest } from "@deskmates/contracts";
import type { SidecarFs } from "./deps.js";
import type { EventSink } from "./ledger.js";
import { WORK_DIR } from "./risk-tier.js";

/** The SDK's project key for a working directory. */
export function sdkProjectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Where the SDK keeps a session's transcript for `cwd`, under the bot's config directory. */
export function sdkTranscriptPath(botHomeDir: string, cwd: string, sessionId: string): string {
  return `${botHomeDir}/.claude/projects/${sdkProjectKey(cwd)}/${sessionId}.jsonl`;
}

/** Session ids are UUIDs in practice; anything else is not turned into a path. */
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;

export async function carrySessionIntoBotDir(
  request: Pick<StartRunRequest, "botHomeDir" | "sdkSessionId">,
  cwd: string,
  fs: SidecarFs,
  sink: Pick<EventSink, "emit">,
): Promise<void> {
  const sessionId = request.sdkSessionId;
  if (sessionId === undefined || !SESSION_ID.test(sessionId) || cwd === WORK_DIR) return;
  const to = sdkTranscriptPath(request.botHomeDir, cwd, sessionId);
  const from = sdkTranscriptPath(request.botHomeDir, WORK_DIR, sessionId);
  try {
    if (await fs.exists(to)) return;
    if (!(await fs.exists(from))) return;
    await fs.writeFile(to, await fs.readFile(from));
    sink.emit("log", { source: "workdir", op: "session_carried", from, to });
  } catch (err) {
    sink.emit("log", {
      source: "workdir",
      op: "session_carried",
      level: "warn",
      to,
      error: String(err),
    });
  }
}
