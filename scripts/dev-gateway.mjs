// Local-development launcher required by ADR-0006. Production invokes the built Gateway directly
// and loadConfig refuses to start without an explicit operator token. Create a local account with
// `npm run auth -- bootstrap-owner` (the root account `admin`).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { GATEWAY_DIR, gatewayChildEnv } from "./gateway-dev-env.mjs";

// Same `.env` and same absolute database path as `npm run auth` (gateway-dev-env.mjs).
gatewayChildEnv();
console.log(`Gateway database: ${process.env.GATEWAY_DB}`);
if (!process.env.GATEWAY_OPERATOR_TOKEN?.trim()) {
  process.env.GATEWAY_OPERATOR_TOKEN = randomBytes(32).toString("base64url");
  console.log(`Local operator credential: ${process.env.GATEWAY_OPERATOR_TOKEN}`);
}
// The Vite dev server is plain HTTP, where browsers drop `Secure` cookies. Local development
// opts into the explicit development cookie mode unless .env says otherwise (ADR-0022 P1).
if (!process.env.GATEWAY_SESSION_COOKIE?.trim()) {
  process.env.GATEWAY_SESSION_COOKIE = "insecure-dev";
  console.log("Session cookies: insecure-dev (plain-HTTP local development)");
}

const child = spawn("tsx", ["watch", "src/index.ts"], {
  cwd: GATEWAY_DIR,
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
