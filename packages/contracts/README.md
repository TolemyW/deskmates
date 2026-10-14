# @deskmates/contracts

Types and protocol definitions shared by every other package. This package has **no runtime dependencies** and **no runtime code** beyond constants and pure validators.

What lives here:

- `bot.ts` — `BotDefinition` (name, role, `workspaceId`, model, connector allowlist, approval rules, cron).
- `connector.ts` — the connector execution contract (ADR-0012): `ConnectorRegistration` (no URL, no credential), the capabilities document, the submission envelope, `ConnectorValidationResult` with field-specific `ConnectorFieldError`s, `ConnectorReceipt` and the Gateway's versioned `ConnectorReceiptRecord`, the `ReceiptStatus` vocabulary, `ConnectorEffect` (`read | reversible | external`) with `riskForEffect` (L0/L1/L2), the five tool names. Pure helpers: `canonicalJson` (the content hash is sha256 of it, computed by the Gateway and the sidecar), `validateAgainstSchema` for the capabilities schema subset, and `parseConnector*` checks the Gateway applies to a connector's answers (`connector_protocol` on a bad one). The typed refusals of a submit are `DeskmatesErrorCode`s in `errors.ts`.
- `cron.ts` — five-field cron (`min hour dom month dow`): `parseCron` (`*`, lists, ranges, `*/5` and `1-10/2` steps; day-of-week 0 and 7 are both Sunday; no month or weekday names), `cronMatches(parsed | expr, date, timeZone?)` for a whole-minute match evaluated in an IANA zone, `nextCronFire(expr, after, timeZone?)` searching up to `CRON_SEARCH_MAX_MINUTES` (366 days). Pure; a bad expression or zone is a `validation` `DeskmatesError`.
- `workspace.ts` — `Workspace` (sandbox provider, status incl. `needs_login`, egress allowlist, optional login probe), `BrowserLock` (holder `run | human`, TTL). There is no per-bot grant and no origin allowlist; see ADR-0004.
- `run.ts` — `Run`, `RunLane` (`interactive | background`), `RunStatus` state machine (incl. `waiting_approval`, `waiting_browser`, terminal `silent`), `RunTriggerKind` (`thread_message | cron | webhook | approval | welcome`), `RunEvent` kinds (`tool_call | tool_result | thinking | screenshot | log | approval | takeover | cap_breached | pricing_missing | turn_usage | compact_boundary | rule_file_modified | memory_index | memory_skipped | cost_alert`); a `RunEvent.seq` is the Gateway's ledger order and `sidecarSeq` the sidecar's own counter.
- `approval.ts` — `RiskLevel` (`L0 | L1 | L2`), `ApprovalDecision`, `Approval` (bot, thread, the `system` message carrying it, `toolUseId`, the waking `instruction`, `decidedBy` as `human:<id>` / `bot:<id>` / `rule:<id>`), `ApprovalRule` with its matcher (tool, origin glob, `argumentPattern` glob over the action's `argumentSummary`), `approvalRuleMatches` / `findMatchingRule` / `matcherFromAction` (pure), `APPROVAL_ATTACHMENT_MIME` (the attachment that links a thread message to its approval), `WaitMode` (`live | deferred`).
- `runtime.ts` — `RuntimeStatus`, the `GET /api/runtime` drain signal (active run count and ids) a release script polls before it stops the Gateway.
- `sandbox.ts` — the `SandboxProvider` interface: `create`, `exec`, `attach`, `removeStaleSandbox` (drop a sandbox whose parts run images other than the configured ones, reporting each `SandboxImageDrift`), `snapshot`, `destroy`, `injectEnv`, `updateEgress`. Implemented by `@deskmates/sandbox-docker` and later a Desktop VM provider.
- `sidecar-protocol.ts` — messages between Gateway and sidecar over the container network: start run (payload, short-lived model token, bot home directory, `attempt` = which process of the run this is), approval request and result (`toolUseId` bound), `approval_decide` from a bot, browser lock acquire/release, takeover/handback, event stream shapes (`SidecarEvent.attempt` + `seq` is the redelivery key: the counter restarts at 1 in every process).
- `thread.ts` — `Thread` (`workspaceId`, `kind: chat | bus`, members, `turnBudget`, `status: active | paused`, `channel` and the optional `externalKey` binding of ADR-0017), `ThreadMessage` (`authorKind: human | bot | system`, `mentions`, `relayCount`, `runId`, optional `externalId`), the `thread_message` trigger payload (unseen message slice + `relayCount`). Replaces the former `BotBusMessage`; see ADR-0005.
- `channel.ts` — chat channels (ADR-0017): `WEB_CHANNEL`, `WHATSAPP_CHANNEL`, the channel name pattern, `isExternalRef` (the bound of an `externalKey` / `externalId`), `channelAuthorId(channel, externalUserId)` (`whatsapp:<wa_id>`) and `ChannelThreadBinding`. Pure; the adapters live in `@deskmates/channels`.
- `cost-alert.ts` — cost alerts (ADR-0018): `CostAlertRule` (`known_cost` with `thresholdUsd`, or `unpriced_usage`; `day` or `month` UTC window; one bot or all), `CostAlert` (one firing per rule and window, with the window's `CostTotals`), the `cost_alert` event payload, and the pure helpers `costAlertWindowKey`, `costAlertWindowRange`, `costAlertRuleSatisfied`.

- `timing.ts` — versioned host phase observations. Start/end pairs carry a span ID,
  monotonic elapsed duration, wall timestamp and optional parent relationship. They
  carry no model content, tool arguments or credentials. Missing ends are incomplete
  observations; nested phase durations cannot be added as total elapsed time.

- `browser-evidence.ts` — the `tool_result.payload.evidence` shapes the sidecar writes
  (`ToolEvidenceReference`, `ToolEvidenceUnavailable`), the cache directory and file-name
  pattern, and `isBrowserEvidencePath`, the only paths the web UI links (issue #65).

- `task.ts` — workspace-scoped operator task records, bounded create/update inputs,
  lifecycle states, current-file artifact references and optimistic versions
  (ADR-0021). Run success is not task delivery or human acceptance; these types
  introduce no sidecar tool or scheduling instruction.

Rules:

- Change a type here first, then update consumers. Never duplicate a shape in another package.
- No imports from other `@deskmates/*` packages.
