# Using Deskmates from another agent

Two ways exist. The quick one is a skill: **Account settings → Connect an agent** gives you a
prompt to paste into Claude Code or any agent that reads skills; the agent downloads the skill
file this Deskmates serves at `/agent-skill/SKILL.md`. The long-lived token is shown separately and
must be enrolled through a user-local hidden prompt or native secret store, never through chat.
After enrollment the agent calls the operator API with `curl` when you ask it to talk to bots, read their work or decide
approvals. The other is `deskmates-agent-mcp`, an MCP server that lets another agent (any MCP
client) hand work to Deskmates bots in batches and collect the results. It runs on the operator
side, next to the client, and talks to the Gateway only through the authenticated operator API.
The full reference is the [package README](../../packages/channels/deskmates-agent-mcp/README.md).

Where you find them: the skill under **Account settings**, the MCP server not in the UI. Their
work shows up in the UI like any other: a chat under **Chats** and, for a submission, a linked
task under **Tasks**.

## Set it up

1. Get a token. Use a service principal token (`deskmates-sp.<token>`), a machine identity for one
   team with its own limit on concurrent runs and daily cost. An Admin or Owner creates one with
   **Create agent token** under **Account settings → Connect an agent** (named after them, with
   their role), through the operator API, or on the Gateway host with
   `auth-cli create-service-principal`; the token is shown once. The shared operator token also
   works, but it acts as an Owner of the Default Tenant with no person behind it.
2. Copy the skill-installation prompt separately. It contains the Gateway and skill URLs, but it
   never contains the issued token or a token assignment. Skill installation works before
   enrollment. When the credential is missing, the skill stops with one setup instruction.
3. Enroll the token outside the agent transcript. A native secret-entry UI is preferred. In a
   local interactive shell, this hidden-input flow creates the supported file without putting the
   token in command history or a process argument:

   ```sh
   umask 077
   mkdir -p "$HOME/.config/deskmates"
   printf "Deskmates URL: "
   IFS= read -r DESKMATES_ENROLL_URL
   printf "Agent token (input hidden): "
   IFS= read -rs DESKMATES_ENROLL_TOKEN
   printf "\n"
   printf 'DESKMATES_URL=%s\nDESKMATES_TOKEN=%s\n' \
     "$DESKMATES_ENROLL_URL" "$DESKMATES_ENROLL_TOKEN" > "$HOME/.config/deskmates/credentials"
   chmod 600 "$HOME/.config/deskmates/credentials"
   unset DESKMATES_ENROLL_TOKEN DESKMATES_ENROLL_URL
   ```

   Configure an MCP client through its protected secret UI when it has one. Optional settings are
   `DESKMATES_WORKSPACE_ID` and `DESKMATES_POLL_INTERVAL_MS`. Never use a tracked file.
4. Tell the agent enrollment is complete. It loads the file without printing it and verifies
   `GET /api/workspaces` with TLS certificate verification enabled. A certificate failure stops
   setup; it is never silently bypassed.

Short-lived device pairing is a future improvement. It is not required for this split flow.

## What it offers

- **Discover:** list workspaces, list bots (id, name, role), and read capacity: free lanes, queued
  and parked runs, who holds the browser lock, sidecar slots in use.
- **Submit:** one call per unit of work, with your own stable `externalKey`. It creates a chat
  with the bot, a message the bot must answer, and a linked task. An optional output schema makes
  the bot's delivered output structured and checked; an optional deadline bounds the work.
  Repeating a key creates nothing and returns the original ids, so a retry is safe.
- **Follow up:** wait for a task (until delivered, accepted or cancelled, until its runs end, or
  until a timeout), read the task and its output, read and post chat messages, read or cancel a
  run.
- **Approvals:** list pending approvals and decide them (allow once, allow always, deny).
- **Files:** download an artifact under `/work/` or `/home/<bot>/` (text up to 256 KiB).

## Good practice

- Spread work across bots and workspaces. One bot runs one run per lane at a time, and all bots in
  a workspace share one browser, so submitting harder to one bot only queues.
- Read `task.output` and the artifacts when a task is delivered. If the runs ended without
  delivering, read the chat to see why, or post a follow-up.
- Read the proposed action before deciding an approval.

## What this cannot do

- There is no tool to accept a task. Accepting a delivered task is a human decision made in the
  UI; a bot or an external agent can deliver, but only a person accepts. See [Tasks](tasks.md).
- A deciding client is a soft boundary, like SOUL and workspace grouping. It is not a security
  boundary. Whoever holds the token can approve what the bots ask for; give it only to an agent you
  would let approve those actions. Allow always stores a rule (or, for a new site, adds the host to
  the workspace's list) until an Admin removes it. See [Approvals](approvals.md).
- It adds no new object to the Gateway and no new isolation: a submission is an ordinary chat
  and task in a workspace, visible to everyone in the team and to the workspace's bots.
- Limits apply: a service principal's own budget (`budget_exceeded`), and the team's request and
  queue limits (`rate_limited`, `queue_full`). Wait and retry.
- Not yet verified against a real MCP client, the real Gateway routes end to end, or a live
  service principal; only tests against a fake Gateway have run.
