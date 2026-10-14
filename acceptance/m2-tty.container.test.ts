// T2: native node-pty process and the run-owned terminal contract, without a model.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const available = await dockerAvailable();
describe.skipIf(!available)("M2 native terminal image smoke", () => {
  let stack: Stack;
  beforeAll(async () => {
    requireWorkspaceImageId();
    stack = await startStack({
      modelBaseUrl: "http://127.0.0.1:1",
      modelAuthToken: "unused-t2-token",
      defaultModel: "unused-model",
      cheapModel: "unused-cheap-model",
      label: "m2-native-tty",
    });
  }, 120_000);
  afterAll(async () => stopStack(stack), 120_000);

  it("runs interactive, bounded and time-limited PTYs in the real image", async () => {
    const script = readFileSync(
      new URL("../spikes/m2-closeout/pty-smoke.mjs", import.meta.url),
      "utf8",
    );
    const result = await stack.provider.exec(stack.handle, {
      cmd: ["node", "--input-type=module", "-e", script],
      timeoutMs: 30_000,
    });
    expect(result.timedOut, result.stderr).toBe(false);
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      nativePty: true,
      interactiveAndIncremental: true,
      slotsAndResize: true,
      ctrlC: true,
      timeout: true,
      attemptOwnership: true,
      outputCap: { characters: 65536 },
    });
  }, 45_000);
});
