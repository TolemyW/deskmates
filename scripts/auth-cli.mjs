// `npm run auth -- <command>`: the sign-in maintenance CLI (packages/gateway/src/auth/cli.ts)
// against the same `.env` and database as `npm run dev:gateway`, via gateway-dev-env.mjs.
// A deployed Gateway uses `node packages/gateway/dist/auth/cli.js` from its own working
// directory instead (docs/runbooks/stable-release.md).

import { spawn } from "node:child_process";
import { GATEWAY_DIR, gatewayChildEnv } from "./gateway-dev-env.mjs";

const env = gatewayChildEnv();
const child = spawn(
  process.execPath,
  ["--import", "tsx", "src/auth/cli.ts", ...process.argv.slice(2)],
  { cwd: GATEWAY_DIR, env, stdio: "inherit" },
);
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
