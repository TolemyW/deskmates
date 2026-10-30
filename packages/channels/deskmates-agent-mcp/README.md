# @deskmates/agent-mcp

`deskmates-agent-mcp` is a stdio MCP server. An external agent (an MCP client) can use it to run
batches of tasks on Deskmates and manage them. Like the chat channel adapters next to it
(ADR-0017), it is an operator-side client. It reaches the Gateway only through the authenticated
operator API, it imports only `@deskmates/contracts` from the workspace packages, and nothing
imports it. It adds no new object to the Gateway. A unit of work is a thread with an
`externalKey` binding, one must-reply message and a linked task (issue #21).

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `DESKMATES_URL` | yes | The Gateway's operator listener, e.g. `https://deskmates.example.com`. http or https, with no credentials in the URL. |
| `DESKMATES_TOKEN` | yes | A service principal token (`deskmates-sp.<token>`, created by a tenant Admin; ADR-0022 amendment 2) or the operator token. |
| `DESKMATES_WORKSPACE_ID` | no | The default workspace for every tool whose `workspaceId` argument is left out. |
| `DESKMATES_POLL_INTERVAL_MS` | no | How often `wait_task` polls. Default 2000, minimum 100. |

**Use an admin-role principal for this server's batch work.** A service principal carries a
tenant role like a person (ADR-0022 amendment 1 A10): `admin` (the default when an Admin or Owner
creates it) or `member` (`role: "member"` at creation, or the CLI's default). Group threads,
tasks, `submit`, persistent approval answers (`allow_always`) and posting outside the principal's
own side chats are Admin acts, so a `member` principal gets 403 `forbidden` on `submit`, on
`post_message` into a thread it did not open as a side chat, on `cancel_run` for a run outside
its own side chats and on `decide_approval` with `allow_always`. A `member` principal can still read every
tool's data and answer approvals with `allow_once` or `deny`.

The token is held only in memory. It is sent only in the `Authorization: Bearer` header. It is
never logged and never written to a file. The server redacts it from every error and log line,
even when the Gateway echoes it back. Diagnostics go to stderr, because stdout carries the
protocol.

Build and run it from the repository root:

```sh
npm run build -w @deskmates/contracts -w @deskmates/agent-mcp
DESKMATES_URL=http://127.0.0.1:8081 DESKMATES_TOKEN=... node packages/channels/deskmates-agent-mcp/dist/main.js
```

Here is an example MCP client entry. The values belong in the client's private configuration,
not in a file that git tracks:

```json
{
  "mcpServers": {
    "deskmates": {
      "command": "node",
      "args": ["/path/to/deskmates/packages/channels/deskmates-agent-mcp/dist/main.js"],
      "env": { "DESKMATES_URL": "https://deskmates.example.com", "DESKMATES_TOKEN": "deskmates-sp.…" }
    }
  }
}
```

## Tools

Each tool is a thin typed call to one operator route. `wait_task` is the exception and uses
three. `openapi.json` documents the routes. Arguments are checked before any request is made, so
a malformed call does not spend the tenant's request budget.

| Tool | Route(s) | What it does |
|---|---|---|
| `list_workspaces` | `GET /api/workspaces` | Lists the workspaces of the credential's tenant. |
| `list_bots(workspaceId)` | `GET /api/bots` | Gives each bot's id, name, role and SOUL version. The SOUL text is not fetched. |
| `get_capacity(workspaceId)` | `GET /api/capacity` | Shows each bot's free lanes, queued and parked runs, the holder of the browser lock, and the sidecar slots. |
| `submit(workspaceId, externalKey, botId, title, instruction, description?, outputSchema?, deadline?, attachments?)` | `POST /api/workspaces/:id/submit` | Needs an admin-role principal (403 for a `member` one). Creates the thread, the must-reply message and the linked task. Returns `{ threadId, taskId, messageId, runs, created }`. `created` is false when the call repeats an earlier `externalKey`; a repeat creates nothing, skips the budget check and returns the original ids. The Gateway refuses unknown keys and a past `deadline` with 400. |
| `get_submission(workspaceId, externalKey)` | `GET /api/workspaces/:id/submissions` | Returns `{ thread, task, latestRun }` for recovery. `task` is null only if an operator unlinked it; `latestRun` is null when no run was created. An unknown key is `not_found`. |
| `get_task(workspaceId, taskId)` | `GET /api/workspaces/:workspaceId/tasks/:id` | Returns the status, linked threads and runs, artifacts, and the delivered `output`. |
| `list_tasks(workspaceId, status?)` | `GET /api/workspaces/:workspaceId/tasks` | Reads every offset page, with the status filter applied by the Gateway. |
| `wait_task(workspaceId, taskId, timeoutSeconds)` | task, `GET /api/runs?threadId=`, `GET /api/runs/:id` | Polls until the task is `delivered`, `accepted` or `cancelled`, or until every linked run has ended, or until the timeout. Returns `outcome`, the task, `latestRun` and `runs`, plus `reason` (`no_reply` or `deadline`) when there is one. |
| `get_messages(threadId, afterSeq?)` | `GET /api/threads/:id/messages` | Reads the transcript after a sequence number. |
| `post_message(threadId, body, mustReply?)` | `POST /api/threads/:id/messages` | Posts a follow-up message. Returns the message and the runs it woke. |
| `get_run(runId)` | `GET /api/runs/:id` | Returns the run, including its `error` reason, and its token usage. |
| `cancel_run(runId)` | `POST /api/runs/:id/cancel` | Cancels a run that has not finished. For a finished run the Gateway answers `invalid_transition`. |
| `list_approvals(threadId?, status?)` | `GET /api/approvals` | Lists pending approvals by default. |
| `decide_approval(approvalId, decision, reason?)` | `POST /api/approvals/:id/decide` | Decides an approval with `allow_once`, `allow_always` or `deny`. |
| `download_artifact(workspaceId, path)` | `GET /api/workspaces/:id/files` (ADR-0014) | Returns text bounded to 256 KiB, with `truncated` set when it was cut. For binary content it returns only the byte count and SHA-256. Only regular files under `/work/` or `/home/<bot>/` can be downloaded. |

There is no `accept_task` tool. Accepting a delivered task is a human decision, made in the
operator UI (ADR-0021 decision 2, amendment 2). A bot or an external agent can deliver a task,
but only a person accepts it.

`wait_task` is not an error when it times out. It returns `outcome: "timeout"`, and you can call
it again. Keep `timeoutSeconds` (at most 3600) below your MCP client's tool-call timeout. When the
client sends a `progressToken`, the server sends progress notifications on every poll. Every poll
spends the tenant's request budget, so do not set `DESKMATES_POLL_INTERVAL_MS` aggressively low.

### Errors

A Gateway refusal comes back as an MCP tool error (`isError: true`) whose text is
`{ "error": { "code", "status", "message", "hint"? } }`. `code` is the Gateway's DeskmatesError
code, for example `not_found`, `validation`, `invalid_transition`, `forbidden` or
`token_rejected`. `gateway_unreachable` means the Gateway could not be reached. Bad arguments
come back as `validation` with no `status`. HTTP 429 errors say in plain words that they are
budget or rate limits:

- `budget_exceeded` means this service principal's own budget (concurrent runs, or today's known
  cost) is spent. Wait for runs to finish, or retry later.
- `rate_limited` and `queue_full` mean the tenant's request or queue budget is spent. Retry later.

### Approvals are a soft boundary

`decide_approval` decides as any thread member may (ADR-0002 amendment 2). With a service
principal, the Gateway records the decider as that principal (`human:service:<id>`), whatever
the request says. A deciding client is a soft boundary, like
SOUL and workspace grouping. It is not a security boundary. Whoever holds the token can approve
what the bots ask for, so give the token only to an agent you would let approve those actions.
`allow_always` persists a rule for that bot. Later matching calls are then allowed without
asking, until an Admin deletes the rule. For an egress approval, `allow_always` instead adds the
host to the workspace allowlist (ADR-0020). Read the proposed action (`list_approvals`) before
you decide.

## The batch pattern

1. Call `list_bots` and pick the bot whose role fits the work. Call `get_capacity` to see how busy
   the workspace is.
2. Make one `submit` per unit of work, with your own stable `externalKey` (a row id, a file hash).
   Each submit is its own thread and task. Repeating the same key never creates a duplicate: it
   returns the original ids with `created: false`. So retrying after a lost response is safe, and
   `get_submission` finds the work again after a crash.
3. Put a JSON Schema in `outputSchema` when you need structured results. The bot's `task_deliver`
   output is validated against it, and `get_task` returns it as `task.output`. Use `deadline` to
   bound the work. Past the deadline, the scheduler cancels the thread's runs and records reason
   `deadline`.
4. Call `wait_task` for each task. `delivered` means the bot declared the work done. Read
   `task.output` and `task.artifacts`, and fetch files with `download_artifact`.
   `runs_terminal` without delivery means the runs ended without delivering. Check `reason`:
   `no_reply` means the bot ended without answering the must-reply instruction. Then use
   `get_messages` to see why, or `post_message` to follow up.
5. If a run is parked on an approval, `list_approvals(threadId)` shows it. Decide it, or leave
   it for a human.

## Throughput limits

The Gateway runs **one run per lane per bot at a time**. A submit wakes the bot on its
interactive lane, so submits to the same bot queue behind each other. All bots in a workspace
share **one browser lock**, so browser-heavy tasks run one at a time per workspace even across
bots. The number of sidecar processes per workspace is capped as well. To go faster, spread the
work across bots and workspaces rather than submitting harder. Use `get_capacity` to pace: free
lanes, queue depth, parked runs, the lock holder, and sidecar slots in use against the limit. A
service principal also has its own concurrent-run and cost budget (HTTP 429 `budget_exceeded`).

## OpenAPI

`openapi.json` is an OpenAPI 3.1 document for exactly the routes the tools call. It is generated
from the table in `src/openapi.ts` (`npm run openapi -w @deskmates/agent-mcp`). `openapi.test.ts`
checks four things: that the file is current, that every tool maps to documented operations
(and every operation to a tool), that every documented route is in the Gateway's route
manifest, and that the fake Gateway serves exactly these operations.

## What is verified and what is not

The T0/T1 tests (`src/*.test.ts`) drive the server through a real MCP client over an in-memory
transport, against a fake Gateway on a loopback port. They cover:

- each tool's happy path and one error path
- `wait_task` completion, runs-terminal (`no_reply`, `deadline`) and timeout
- the token never appearing in a log line, tool error or URL
- configuration
- the package boundary
- the OpenAPI mapping

Not verified:

- the stdio binary against a real MCP client
- the real Gateway routes end to end. The fake mirrors their shapes, and the submit and
  submission shapes are typed by contracts `SubmitRequest`, `SubmitResponse` and
  `SubmissionResponse`, but no test drives this server against a running Gateway.
- a live service principal
