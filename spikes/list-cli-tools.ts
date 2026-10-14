// One-off: print the built-in tool names the SDK's CLI offers the model, as recorded by the fake
// upstream through the real stack. Run with `npx tsx spikes/list-cli-tools.ts` (needs Docker).
import { postMessage, waitForRun } from "../acceptance/support/runs.js";
import { startFakeModelUpstream } from "../acceptance/support/fake-model-upstream.js";
import { startStack } from "../acceptance/support/start-stack.js";
import { stopStack } from "../acceptance/support/stop-stack.js";

const TOKEN = "fake-upstream-token-list-tools";
const upstream = await startFakeModelUpstream({ reply: "pong", expectedToken: TOKEN });
const stack = await startStack({
  modelBaseUrl: upstream.url,
  modelAuthToken: TOKEN,
  defaultModel: "fake-upstream-model",
  cheapModel: "fake-upstream-model-cheap",
  label: "tools",
});
try {
  const { run } = await postMessage(stack, "ping");
  await waitForRun(stack, run.id, 5 * 60_000);
  const body = upstream.requests[0]?.body as { tools?: { name: string }[] } | undefined;
  console.log(JSON.stringify((body?.tools ?? []).map((t) => t.name)));
} finally {
  await stopStack(stack);
  await upstream.close();
}
