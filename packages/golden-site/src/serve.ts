// CLI entry for `npm run golden-site`: serve the Galaxy Ops Console on GOLDEN_SITE_PORT (default 4477).

import { startGoldenSite } from "./server.js";

const port = Number(process.env.GOLDEN_SITE_PORT ?? "4477");
const host = process.env.GOLDEN_SITE_HOST ?? "127.0.0.1";

const site = await startGoldenSite({ port, host });
console.log(`Galaxy Ops Console listening on ${site.url}`);
console.log(
  "Accounts: ops@galaxy.test (no MFA), mfa@galaxy.test (MFA 246810); password Galaxy#2026",
);
console.log(`State: GET ${site.url}/api/state, POST ${site.url}/api/state/reset`);

const shutdown = (): void => {
  site.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
