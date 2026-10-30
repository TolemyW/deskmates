// ADR-0029 T2 helper: replace the stack's Gateway with a new process on the same database and the
// same port, the way an upgrade or a crash-and-restart does. The workspace container is left
// running, so a sidecar the old Gateway started is still there for the new one to find and kill.
// `stopStack` then tears down the new Gateway as it would have the old one.

import { buildGateway } from "@deskmates/gateway";
import type { Stack } from "./start-stack.js";

export async function restartGateway(
  stack: Stack,
  changes: Partial<Stack["config"]> = {},
): Promise<void> {
  const port = Number(new URL(stack.gatewayUrl).port);
  // The old process stops owning its runs first; its in-flight execs resolve into nothing.
  stack.app.deskmates.scheduler.stop();
  await stack.app.close();
  Object.assign(stack.config, changes);
  const app = buildGateway(stack.config, stack.provider, {
    surface: "combined-test",
    startCron: false,
  });
  await app.listen({ port, host: "0.0.0.0" });
  stack.app = app;
}
