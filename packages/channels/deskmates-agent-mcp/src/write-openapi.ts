// Regenerates ../openapi.json from the operation table: `npm run openapi -w @deskmates/agent-mcp`,
// which also runs Biome's formatter on it so `npm run lint` stays clean.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "./openapi.js";

const target = fileURLToPath(new URL("../openapi.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
