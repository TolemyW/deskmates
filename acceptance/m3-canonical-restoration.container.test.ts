// ADR-0011 A5 / UX-01: real SDK Bash edits are observed, then the next resumed run
// receives the Gateway's canonical files. This is restoration, not a file-access boundary.
import { type BotDefinition, type Thread, botHomeDir } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setCanonicalSoul } from "./support/canonical-soul.js";
import { dockerAvailable } from "./support/docker.js";
import {
  type FakeModelUpstream,
  type FakeTurn,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import { newThread, postMessage, runEvents, waitForRun } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const available = await dockerAvailable();
const botName = "canonicalcheck";
const home = botHomeDir(botName);
const soul = "# Canonical test\n\nM3_CANONICAL_RULE: Report observed facts.\n";
const changed = "M3_CHANGED_FILE";
const token = "fake-canonical-restoration";
const peerName = "canonicalpeer";
const peerHome = botHomeDir(peerName);
const peerSoul = "# Peer canonical test\n\nM3_PEER_CANONICAL_RULE: Retain operator instructions.\n";

function results(body: Record<string, unknown> | undefined): number {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.reduce((count, message) => {
    if (!message || typeof message !== "object") return count;
    const content = (message as { content?: unknown }).content;
    return (
      count +
      (Array.isArray(content) ? content.filter((block) => block?.type === "tool_result").length : 0)
    );
  }, 0);
}

describe.skipIf(!available)("M3 canonical files across real SDK runs (T2)", () => {
  let upstream: FakeModelUpstream | undefined;
  let stack: Stack | undefined;
  beforeAll(async () => {
    upstream = await startFakeModelUpstream({
      expectedToken: token,
      reply: "unused",
      script: (_turn, body): FakeTurn => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0)
          return { kind: "text", text: "OK" };
        const messages = JSON.stringify(body.messages);
        if (JSON.stringify(body.system).includes("M3_PEER_CANONICAL_RULE")) {
          if (messages.includes("M3_VERIFY_PEER") && results(body) === 0)
            return {
              kind: "tool_use",
              name: "Bash",
              input: { command: `cat ${peerHome}/SOUL.md ${peerHome}/MEMORY.md` },
            };
          return { kind: "text", text: "Peer canonical files checked." };
        }
        if (messages.includes("M3_INITIALIZE_OWN") && !messages.includes("M3_TAMPER_PEERS"))
          return { kind: "text", text: "Own canonical fixture initialized." };
        if (messages.includes("M3_VERIFY_BOTH")) {
          if (results(body) < 2)
            return {
              kind: "tool_use",
              name: "Bash",
              input: { command: `cat ${home}/SOUL.md ${home}/MEMORY.md` },
            };
          return { kind: "text", text: "Own canonical files checked." };
        }
        if (messages.includes("M3_TAMPER_PEERS")) {
          if (results(body) === 0)
            return {
              kind: "tool_use",
              name: "Bash",
              input: {
                command: [home, peerHome]
                  .flatMap((dir) =>
                    ["SOUL.md", "MEMORY.md"].map(
                      (file) => `printf '${changed}\\n' > ${dir}/${file}`,
                    ),
                  )
                  .join("; "),
              },
            };
          return { kind: "text", text: "Both bots' fixture files changed." };
        }
        if (JSON.stringify(body.messages).includes("M3_VERIFY_RESTORE")) {
          if (results(body) < 2)
            return {
              kind: "tool_use",
              name: "Bash",
              input: { command: `cat ${home}/SOUL.md ${home}/MEMORY.md` },
            };
          return { kind: "text", text: "Canonical files checked." };
        }
        if (results(body) === 0)
          return {
            kind: "tool_use",
            name: "Bash",
            input: {
              command: `printf '${changed}\\n' > ${home}/SOUL.md; printf '${changed}\\n' > ${home}/MEMORY.md`,
            },
          };
        return { kind: "text", text: "Fixture files changed." };
      },
    });
    stack = await startStack({
      modelBaseUrl: upstream.url,
      modelAuthToken: token,
      defaultModel: "fake-canonical-files",
      cheapModel: "fake-canonical-files",
      label: "m3-canonical",
      botName,
      soul,
    });
  }, 180_000);
  afterAll(async () => {
    try {
      await stopStack(stack);
    } finally {
      await upstream?.close();
    }
  }, 120_000);

  it("records both actual edits and restores canonical content before the resumed SDK reads it", async () => {
    if (!stack || !upstream) throw Error("canonical fixture not ready");
    const read = async (path: string) => {
      const result = await stack?.provider.exec(stack.handle, {
        cmd: ["cat", path],
        timeoutMs: 10_000,
      });
      expect(result?.exitCode).toBe(0);
      return result?.stdout;
    };
    const first = await postMessage(stack, "M3_TAMPER_TEST: perform the controlled fixture write.");
    expect((await waitForRun(stack, first.run.id, 180_000)).status).toBe("succeeded");
    expect(await read(`${home}/SOUL.md`)).toBe(`${changed}\n`);
    expect(await read(`${home}/MEMORY.md`)).toBe(`${changed}\n`);
    const edits = (await runEvents(stack, first.run.id)).filter(
      (event) => event.kind === "rule_file_modified",
    );
    expect(edits.map((event) => event.payload.fileName).sort()).toEqual(["MEMORY.md", "SOUL.md"]);
    expect(edits.every((event) => event.payload.restoredOnNextRun === true)).toBe(true);
    const requestOffset = upstream.requests.length;
    const second = await postMessage(stack, "M3_VERIFY_RESTORE: read the current canonical files.");
    expect((await waitForRun(stack, second.run.id, 180_000)).status).toBe("succeeded");
    expect(await read(`${home}/SOUL.md`)).toBe(soul);
    expect(await read(`${home}/MEMORY.md`)).not.toContain(changed);
    const events = await runEvents(stack, second.run.id);
    const calls = events.filter(
      (event) => event.kind === "tool_call" && event.payload.toolName === "Bash",
    );
    expect(
      calls.some((event) => JSON.stringify(event.payload.input).includes(`${home}/SOUL.md`)),
    ).toBe(true);
    expect(
      events
        .filter((event) => event.kind === "tool_result")
        .some((event) => String(event.payload.content).includes("M3_CANONICAL_RULE")),
    ).toBe(true);
    const modelCalls = upstream.requests
      .slice(requestOffset)
      .filter((request) => Array.isArray(request.body?.tools) && request.body.tools.length > 0);
    expect(modelCalls.length).toBeGreaterThan(0);
    expect(
      modelCalls.some((request) =>
        JSON.stringify(request.body?.system)?.includes("M3_CANONICAL_RULE"),
      ),
    ).toBe(true);
    const run = stack.app.deskmates.ctx.runs.mustGet(second.run.id);
    expect(run.sdkSessionId).toBe(stack.app.deskmates.ctx.runs.mustGet(first.run.id).sdkSessionId);
  }, 420_000);

  it("audits edits to both bots and restores each canonical copy in its own resumed SDK run", async () => {
    if (!stack || !upstream) throw Error("canonical fixture not ready");
    const activeStack = stack;
    const read = async (path: string): Promise<string> => {
      const result = await activeStack.provider.exec(activeStack.handle, {
        cmd: ["cat", path],
        timeoutMs: 10_000,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      return result.stdout;
    };
    const created = await stack.api<{
      bot: BotDefinition;
      privateChat: Thread;
      welcomeRun: { id: string };
    }>("POST", "/api/bots", {
      workspaceId: stack.workspace.id,
      name: peerName,
      role: "Canonical peer fixture",
    });
    expect(created.status).toBe(201);
    stack.app.deskmates.scheduler.cancel(
      created.json.welcomeRun.id as import("@deskmates/contracts").RunId,
      "test",
    );
    await stack.app.deskmates.scheduler.drain();
    await setCanonicalSoul(stack.api, created.json.bot.id, peerSoul);
    const peerThread = created.json.privateChat;
    const humanNotes = [
      "M3_OWN_HUMAN_NOTE: Keep the operator's source reference.",
      "M3_PEER_HUMAN_NOTE: Preserve the operator's retention note.",
    ];
    for (const [id, body] of [
      [stack.bot.id, humanNotes[0]],
      [created.json.bot.id, humanNotes[1]],
    ] as const) {
      const route = `/api/bots/${id}/memory`;
      const current = await stack.api<{ memory: { version: string } }>("GET", route);
      expect(current.status).toBe(200);
      const saved = await stack.api("PATCH", route, {
        body,
        expectedVersion: current.json.memory.version,
      });
      expect(saved.status).toBe(200);
    }
    const boot = await postMessage(
      stack,
      "M3_INITIALIZE_PEER: initialize the fixture files.",
      peerThread.id,
    );
    expect((await waitForRun(stack, boot.run.id, 180_000)).status).toBe("succeeded");
    expect(await read(`${peerHome}/SOUL.md`)).toBe(peerSoul);
    const ownThread = await newThread(stack, "Cross-bot canonical restoration");
    const ownBoot = await postMessage(
      stack,
      "M3_INITIALIZE_OWN: initialize the fixture files.",
      ownThread.id,
    );
    expect((await waitForRun(stack, ownBoot.run.id, 180_000)).status).toBe("succeeded");
    const memories = await Promise.all([home, peerHome].map((dir) => read(`${dir}/MEMORY.md`)));
    expect(memories[0]).toContain(humanNotes[0]);
    expect(memories[1]).toContain(humanNotes[1]);
    const tamper = await postMessage(
      stack,
      "M3_TAMPER_PEERS: perform the controlled fixture writes.",
      ownThread.id,
    );
    expect((await waitForRun(stack, tamper.run.id, 180_000)).status).toBe("succeeded");
    const paths = [home, peerHome].flatMap((dir) =>
      ["SOUL.md", "MEMORY.md"].map((file) => `${dir}/${file}`),
    );
    expect(await Promise.all(paths.map(read))).toEqual(paths.map(() => `${changed}\n`));
    const edits = (await runEvents(stack, tamper.run.id)).filter(
      (e) => e.kind === "rule_file_modified",
    );
    expect(edits.map((e) => e.payload.path).sort()).toEqual([...paths].sort());
    const peerEdits = edits.filter((e) => String(e.payload.path).startsWith(`${peerHome}/`));
    expect(peerEdits).toHaveLength(2);
    expect(peerEdits.every((e) => e.payload.observation === "peer_file_changed_during_run")).toBe(
      true,
    );
    // A peer observation makes no isolation/restoration promise; the peer's next run proves it.
    expect(peerEdits.every((e) => e.payload.restoredOnNextRun === false)).toBe(true);
    for (const [botId, expected] of [
      [stack.bot.id, soul],
      [created.json.bot.id, peerSoul],
    ] as const) {
      const canonical = await stack.api<{ soul: { body: string } }>(
        "GET",
        `/api/bots/${botId}/soul`,
      );
      expect(canonical.status).toBe(200);
      expect(canonical.json.soul.body).toBe(expected);
    }
    const offset = upstream.requests.length;
    const verifyOwn = await postMessage(
      stack,
      "M3_VERIFY_BOTH: read restored own files.",
      ownThread.id,
    );
    const verifyPeer = await postMessage(
      stack,
      "M3_VERIFY_PEER: read restored peer files.",
      peerThread.id,
    );
    const verified = await Promise.all(
      [verifyOwn, verifyPeer].map(({ run }) => waitForRun(activeStack, run.id, 180_000)),
    );
    expect(verified.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
    expect(await Promise.all(paths.map(read))).toEqual([soul, memories[0], peerSoul, memories[1]]);
    for (const [verifiedRun, originalRun, expected] of [
      [verifyOwn.run, tamper.run, "M3_CANONICAL_RULE"],
      [verifyPeer.run, boot.run, "M3_PEER_CANONICAL_RULE"],
    ] as const) {
      const done = stack.app.deskmates.ctx.runs.mustGet(verifiedRun.id);
      expect(done.sdkSessionId).toBe(
        stack.app.deskmates.ctx.runs.mustGet(originalRun.id).sdkSessionId,
      );
      expect(done.sdkSessionId).toBeTruthy();
      expect(
        (await runEvents(stack, done.id)).some(
          (e) => e.kind === "tool_result" && String(e.payload.content).includes(expected),
        ),
      ).toBe(true);
    }
    // Only turns: the CLI's count_tokens requests carry the tools but no system prompt.
    const restoredRequests = upstream.requests
      .slice(offset)
      .filter((r) => (r.url.split("?", 1)[0] ?? r.url) === "/v1/messages")
      .filter((r) => Array.isArray(r.body?.tools) && r.body.tools.length > 0);
    expect(
      restoredRequests.some((r) => JSON.stringify(r.body?.system).includes("M3_CANONICAL_RULE")),
    ).toBe(true);
    expect(
      restoredRequests.some((r) =>
        JSON.stringify(r.body?.system).includes("M3_PEER_CANONICAL_RULE"),
      ),
    ).toBe(true);
  }, 600_000);
});
