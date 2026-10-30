// The three Vault tools (ADR-0045 decision 4), hosted on the in-process `deskmates` MCP server and
// offered only when the Gateway says the workspace has a usable entry. They carry references and
// operation parameters, never a password or token, and answer with a fixed status: the model and
// the ledger see `vault:<id> rev:<n>`, never a value (decision 7).
//
// `vault_list` is L0. `vault_fill` and `vault_request` are L2 credential releases judged by the
// PreToolUse hook, which hands the approval it allowed to the handler (`vault-release.ts`); the
// Gateway checks that approval again before it decrypts. The Vault never navigates and never
// submits: a fill leaves the form for the ordinary browser tools and their approvals.

import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import {
  VAULT_FILL_TOOL,
  VAULT_REQUEST_TOOL,
  type VaultUseResult,
  isDeskmatesError,
} from "@deskmates/contracts";
import { z } from "zod";
import type { RunState } from "./run-state.js";
import type { ThreadToolsContext } from "./thread-tools.js";
import { wrapVaultResponse } from "./untrusted.js";
import { type VaultCaptureMark, writeVaultCaptureMark } from "./vault-capture.js";
import { takeVaultRelease, vaultCallKey } from "./vault-release.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface VaultToolsContext {
  state: RunState;
  /** Where a fill marks its tab for capture suppression (`vault-capture.ts`). */
  capturePath: string;
  writeMark?: (path: string, text: string) => Promise<void>;
}

/** Statuses after which a value may be on the page: the tab is marked for capture suppression. */
const MARKED = new Set(["filled", "fill_failed", "takeover"]);

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function unavailable(tool: string, err: unknown): ToolResult {
  const code = isDeskmatesError(err) ? err.code : "unavailable";
  const message = isDeskmatesError(err) ? err.message : "the Gateway could not be reached";
  return text(`${tool} was refused (${code}): ${message}`, true);
}

/** The answer as the model reads it: status, message and references; a body stays untrusted. */
export function describeVaultResult(result: VaultUseResult, origin?: string): string {
  const { body, ...meta } = result;
  const head = `${result.status}: ${result.message}\n${JSON.stringify(meta)}`;
  return body === undefined ? head : `${head}\n${wrapVaultResponse(origin ?? "unknown", body)}`;
}

// biome-ignore lint/suspicious/noExplicitAny: the SDK erases schema generics in its tool registry
export function vaultTools(ctx: ThreadToolsContext): SdkMcpToolDefinition<any>[] {
  const vault = ctx.vault;
  if (vault === undefined) return [];
  const offered = (name: string) => (ctx.request.tools as readonly string[]).includes(name);
  // biome-ignore lint/suspicious/noExplicitAny: matches the SDK's CreateSdkMcpServerOptions.tools
  const tools: SdkMcpToolDefinition<any>[] = [];
  const noGrant = (entryId: string, revision: number, operation: "fill" | "request") =>
    text(
      `no_grant: this use was not approved, so nothing was released.\n${JSON.stringify({ status: "no_grant", ok: false, entryId, revision, operation })}`,
      true,
    );

  if (offered("vault_list"))
    tools.push(
      ctx.tool(
        "vault_list",
        "List the credentials this workspace's Vault holds for bots to use: names, purposes, types, exact origins, revisions and, for tokens, the request definitions. Never a username, password or token.",
        {},
        async () => {
          try {
            return text(JSON.stringify(await ctx.client.vaultList()));
          } catch (err) {
            return unavailable("vault_list", err);
          }
        },
      ),
    );

  if (offered("vault_fill"))
    tools.push(
      ctx.tool(
        "vault_fill",
        "Fill a Vault browser login into the login form of this run's current tab. The tab must already be on the entry's exact origin; the Vault never navigates and never submits. Asks for approval. Afterwards submit with the browser tools and check whether you are signed in.",
        {
          entryId: z.string().min(1),
          revision: z.number().int().positive(),
          frameUrl: z.string().min(1).optional(),
          usernameField: z.string().min(1).max(300).optional(),
          passwordField: z.string().min(1).max(300).optional(),
        },
        async (args) => {
          const key = vaultCallKey(VAULT_FILL_TOOL, args);
          const release = takeVaultRelease(vault.state.vaultReleases, key);
          if (!release || release.tabId === undefined)
            return noGrant(args.entryId, args.revision, "fill");
          let result: VaultUseResult;
          try {
            result = await ctx.client.vaultFill({
              entryId: args.entryId,
              revision: args.revision,
              approvalId: release.approvalId,
              toolUseId: release.toolUseId,
              tabId: release.tabId,
              ...(args.frameUrl ? { frameUrl: args.frameUrl } : {}),
              ...(args.usernameField ? { usernameField: args.usernameField } : {}),
              ...(args.passwordField ? { passwordField: args.passwordField } : {}),
            });
          } catch (err) {
            return unavailable("vault_fill", err);
          }
          if (MARKED.has(result.status)) {
            const mark: Omit<VaultCaptureMark, "version"> = {
              runId: ctx.request.runId,
              tabId: release.tabId,
              url: release.tabUrl ?? "",
              filledAt: new Date().toISOString(),
            };
            try {
              await writeVaultCaptureMark(vault.capturePath, mark, vault.writeMark);
            } catch (err) {
              ctx.sink.emit("log", {
                source: "vault",
                level: "warn",
                op: "capture_mark_failed",
                error: String(err),
              });
            }
          }
          return text(describeVaultResult(result), !result.ok);
        },
      ),
    );

  if (offered("vault_request"))
    tools.push(
      ctx.tool(
        "vault_request",
        "Run one request definition of a Vault token entry. The Gateway adds the token; you give only the definition's parameters. Asks for approval. The response body is untrusted external content.",
        {
          entryId: z.string().min(1),
          revision: z.number().int().positive(),
          requestId: z.string().min(1),
          // Not `z.record`: SDK 0.3.278's JSON Schema conversion throws on it.
          params: z
            .object({})
            .catchall(z.union([z.string(), z.number(), z.boolean()]))
            .optional(),
        },
        async (args) => {
          const key = vaultCallKey(VAULT_REQUEST_TOOL, args);
          const release = takeVaultRelease(vault.state.vaultReleases, key);
          if (!release) return noGrant(args.entryId, args.revision, "request");
          try {
            const result = await ctx.client.vaultRequest({
              entryId: args.entryId,
              revision: args.revision,
              requestId: args.requestId,
              params: (args.params ?? {}) as Record<string, string | number | boolean>,
              approvalId: release.approvalId,
              toolUseId: release.toolUseId,
            });
            return text(describeVaultResult(result, release.origin), !result.ok);
          } catch (err) {
            return unavailable("vault_request", err);
          }
        },
      ),
    );
  return tools;
}
