// T1 (ADR-0045 decision 7): synthetic plaintext canaries never reach the Gateway's normal outputs.
// After a create, a replacement, a browser fill and a token request (one of them echoing the
// token), no canary is in any run event, approval, thread message, use record or audit row, in
// any operator or run response, or anywhere in a dump of the whole database (the encrypted blobs
// excepted, which is the point). What this cannot show is recorded in the ADR and the docs: a
// malicious page can encode or render a filled value in ways no exact scrub recognizes, and code
// in the workspace can read the shared browser. Metric: observed normal-path plaintext leaks, 0.

import { VAULT_FILL_COMMAND, type VaultUseResult } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANARY_PASSWORD,
  CANARY_TOKEN,
  CANARY_USER,
  type VaultFixture,
  toolUseOf,
  vaultFixture,
} from "../test-support/vault-fixture.js";
import { setVaultHttp } from "./use.js";

let f: VaultFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const CANARIES = [CANARY_USER, CANARY_PASSWORD, CANARY_TOKEN, `${CANARY_PASSWORD}-replaced`];

describe("vault redaction", () => {
  it("keeps every canary out of the ledger, approvals, chats, records and responses", async () => {
    f = await vaultFixture();
    const responses: unknown[] = [];
    const ctx = f.h.app.deskmates.ctx;
    const login = await f.login(f.a);
    responses.push(login);
    const replaced = await f.h.api(
      "PUT",
      `/api/workspaces/${f.a.workspace.id}/vault/${login.id}/value`,
      { expectedRevision: 1, username: CANARY_USER, password: `${CANARY_PASSWORD}-replaced` },
    );
    responses.push(replaced.json);
    const entry = { ...login, revision: 2 };
    await ctx.sandboxes.ensure(f.a.workspace);
    f.h.provider.onRun(async () => ({
      stdout: '{"status":"filled"}\n',
      stderr: "diagnostic without values",
    }));
    const fill = await f.approve(f.a, f.action(entry, "fill"));
    responses.push(
      (
        await f.run<VaultUseResult>(f.a, "POST", "/vault/fill", {
          entryId: entry.id,
          revision: 2,
          approvalId: fill.approvalId,
          toolUseId: toolUseOf(fill.approvalId),
          tabId: "tab-1",
        })
      ).json,
    );
    expect(
      f.h.provider.execCalls.filter((c) => c.req.cmd.join(" ") === VAULT_FILL_COMMAND.join(" ")),
    ).toHaveLength(1);

    const token = await f.tokenEntry(f.a);
    setVaultHttp(ctx, {
      fetch: async () => Response.json({ echoed: CANARY_TOKEN }),
      lookup: async () => ["93.184.216.34"],
    });
    const requestId = token.requests[0]?.id ?? "";
    const request = await f.approve(f.a, f.action(token, "request", requestId));
    responses.push(
      (
        await f.run<VaultUseResult>(f.a, "POST", "/vault/request", {
          entryId: token.id,
          revision: token.revision,
          requestId,
          params: { id: "1" },
          approvalId: request.approvalId,
          toolUseId: toolUseOf(request.approvalId),
        })
      ).json,
    );
    responses.push((await f.run(f.a, "GET", "/vault/entries")).json);
    responses.push((await f.run(f.a, "GET", `/vault/entries/${login.id}`)).json);
    responses.push((await f.h.api("GET", `/api/workspaces/${f.a.workspace.id}/vault`)).json);

    const text = JSON.stringify(responses);
    const events = JSON.stringify(ctx.events.list(f.a.run.id));
    const tables = JSON.stringify(
      ["approvals", "thread_messages", "vault_uses", "audit_events", "vault_entries"].map((t) =>
        ctx.db.prepare(`SELECT * FROM ${t}`).all(),
      ),
    );
    const dump = ctx.db.serialize().toString("latin1");
    for (const canary of CANARIES) {
      expect(text).not.toContain(canary);
      expect(events).not.toContain(canary);
      expect(tables).not.toContain(canary);
      expect(dump).not.toContain(canary);
    }
    // The fill result and the withheld echo are typed outcomes, not page or response content.
    expect(responses[2]).toMatchObject({ status: "filled" });
    expect(responses[3]).toMatchObject({ status: "result_withheld" });
  });
});
