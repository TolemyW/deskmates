// T3: a model proposes knowledge; a human publishes; a different model session retrieves it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeDocument, KnowledgeProposal, Thread } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { missingModelEnv, modelEnv, skipReason } from "./support/env.js";
import { createGroupBot, createGroupThread, ensureReportDir } from "./support/m2-group.js";
import { postMessage, runEvents, toolCalls, waitForRun } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const skip = missing.length > 0 || !dockerUp;
const marker = "m2knowledgequartz739";
const reportDir = process.env.M2_BUSINESS_REPORT_DIR;

describe.skipIf(skip)(`M2 model knowledge publication${skipReason(missing, dockerUp)}`, () => {
  let stack: Stack;
  let readerThread: Thread;
  let writerRunId: string | undefined;
  let readerRunId: string | undefined;
  let proposalId: string | undefined;
  let publishedId: string | undefined;
  let completed = false;
  let failure: string | undefined;
  beforeAll(async () => {
    try {
      requireWorkspaceImageId();
      stack = await startStack({
        ...modelEnv(),
        label: "m2-knowledge-model",
        botName: "m2_knowledge_writer",
        soul: "# m2_knowledge_writer\nYou preserve useful team reference facts. When the human asks you to propose a fact, call knowledge_propose exactly once with the given title and body. Proposal is review only. Do not publish it yourself. Reply briefly. Return the required fenced JSON run summary.",
      });
      stack.config.maxTurns = 8;
      stack.config.runTimeoutSeconds = 180;
      const reader = await createGroupBot(stack, {
        name: "m2_knowledge_reader",
        role: "knowledge lookup",
        soul: "# m2_knowledge_reader\nFor a knowledge lookup, call knowledge_search with the exact marker. If it returns a document ID, call knowledge_read with that ID. Answer with the document ID, version and body fact. Do not guess. Return the required fenced JSON run summary.",
      });
      readerThread = await createGroupThread(stack, [reader], "M2 approved knowledge reader");
    } catch (error) {
      failure = `setup: ${String(error)}`;
      throw error;
    }
  }, 120_000);
  afterAll(async () => {
    try {
      const output = ensureReportDir(reportDir);
      if (output) {
        const runs = await Promise.all(
          [writerRunId, readerRunId]
            .filter((id): id is string => !!id)
            .map(async (id) => {
              const response = await stack
                ?.api<{ run: { id: string; status: string; attempt: number }; usage: unknown[] }>(
                  "GET",
                  `/api/runs/${id}`,
                )
                .catch(() => undefined);
              return {
                id,
                run: response?.json.run,
                usage: response?.json.usage,
                events: stack ? await runEvents(stack, id).catch(() => []) : [],
              };
            }),
        );
        const request = async (path: string): Promise<unknown> =>
          stack
            ?.api("GET", path)
            .then((result) => result.json)
            .catch(() => undefined);
        const evidence = {
          passed: completed && !failure,
          ...(failure ? { error: failure } : {}),
          marker,
          writerRunId,
          readerRunId,
          proposalId,
          publishedId,
          runs,
          pendingProposals: await request("/api/knowledge/proposals?status=pending"),
          approvedProposals: await request("/api/knowledge/proposals?status=approved"),
          publishedDocument: publishedId
            ? await request(`/api/knowledge/${publishedId}`)
            : undefined,
          publishedSearch: await request(`/api/knowledge?q=${marker}`),
        };
        let json = JSON.stringify(evidence, null, 2);
        for (const secret of [stack?.config.modelAuthToken, stack?.config.operatorToken]) {
          if (secret) json = json.replaceAll(secret, "[redacted]");
        }
        writeFileSync(join(output, "knowledge-results.json"), json);
      }
    } finally {
      await stopStack(stack);
    }
  }, 120_000);

  it("keeps the model's proposal hidden until operator review, then gives the next bot the approved ID and version", async () => {
    try {
      const writer = await postMessage(
        stack,
        `Propose this team reference knowledge. Title: M2 quartz routing. Body: ${marker} means route the review packet to Delta desk. Call knowledge_propose and stop.`,
      );
      writerRunId = writer.run.id;
      const writerRun = await waitForRun(stack, writer.run.id, 180_000);
      expect(writerRun.status).toMatch(/^(succeeded|silent)$/);
      expect(toolCalls(await runEvents(stack, writer.run.id), "knowledge_propose")).toHaveLength(1);
      const pending = await stack.api<{ proposals: KnowledgeProposal[] }>(
        "GET",
        "/api/knowledge/proposals?status=pending",
      );
      const proposal = pending.json.proposals.find((item) => item.sourceRunId === writer.run.id);
      expect(proposal).toMatchObject({
        title: "M2 quartz routing",
        status: "pending",
        sourceRunId: writer.run.id,
      });
      if (!proposal) throw new Error(`run ${writer.run.id} produced no pending proposal`);
      proposalId = proposal.id;
      expect(
        (await stack.api<{ documents: unknown[] }>("GET", `/api/knowledge?q=${marker}`)).json
          .documents,
      ).toEqual([]);
      expect((await stack.api("GET", `/api/knowledge/${proposal.id}`)).status).toBe(404);
      const reviewed = await stack.api<{ proposal: KnowledgeProposal }>(
        "POST",
        `/api/knowledge/proposals/${proposal.id}/review`,
        { decision: "approve", authorId: "m2-reviewer" },
      );
      expect(reviewed.status).toBe(200);
      const id = reviewed.json.proposal.documentId;
      if (!id) throw new Error("approval returned no document ID");
      publishedId = id;
      const approved = await stack.api<{ document: KnowledgeDocument }>(
        "GET",
        `/api/knowledge/${id}`,
      );
      expect(approved.json.document).toMatchObject({ id, version: 1, sourceRunId: writer.run.id });
      expect(approved.json.document.body).toContain(marker);

      const reader = await postMessage(
        stack,
        `Look up ${marker} in approved knowledge. Call knowledge_search, then knowledge_read for the matching ID. Report the exact ID, version and routing fact.`,
        readerThread.id,
      );
      readerRunId = reader.run.id;
      const readerRun = await waitForRun(stack, reader.run.id, 180_000);
      expect(readerRun.status).toMatch(/^(succeeded|silent)$/);
      const events = await runEvents(stack, reader.run.id);
      expect(toolCalls(events, "knowledge_search").length).toBeGreaterThan(0);
      const readCall = toolCalls(events, "knowledge_read").find(
        (event) => (event.payload.input as { id?: string } | undefined)?.id === id,
      );
      expect(readCall, `reader run ${reader.run.id} did not read published ${id}`).toBeDefined();
      const readResult = events.find(
        (event) =>
          event.kind === "tool_result" && event.payload.toolUseId === readCall?.payload.toolUseId,
      );
      expect(String(readResult?.payload.content)).toContain(`"id":"${id}"`);
      expect(String(readResult?.payload.content)).toContain('"version":1');
      const lookedUp = await stack.api<{ documents: { id: string; version: number }[] }>(
        "GET",
        `/api/knowledge?q=${marker}`,
      );
      expect(lookedUp.json.documents).toContainEqual(expect.objectContaining({ id, version: 1 }));
      completed = true;
    } catch (error) {
      failure = String(error);
      throw error;
    }
  }, 420_000);
});
