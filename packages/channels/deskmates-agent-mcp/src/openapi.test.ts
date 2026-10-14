// The OpenAPI document is generated from the hand-written operation table; every tool maps to
// documented operations, the committed openapi.json is current, and every documented route is a
// real Gateway route (read as text from the route manifest; this package never imports the
// Gateway).

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATIONS, buildOpenApiDocument, policyKey } from "./openapi.js";
import { type FakeGateway, startFakeGateway } from "./test-support/fake-gateway.js";
import { TOOLS } from "./tools.js";

const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
/** The Gateway's route policies, one file per domain, aggregated by `api/route-policy.ts`. */
const ROUTE_POLICIES = fileURLToPath(
  new URL("../../../gateway/src/api/route-policies/", import.meta.url),
);

type Doc = {
  openapi: string;
  paths: Record<string, Record<string, { operationId: string }>>;
};

const operationIds = (doc: Doc): string[] =>
  Object.values(doc.paths).flatMap((item) => Object.values(item).map((op) => op.operationId));

describe("openapi.json", () => {
  it("is the generated document (run `npm run openapi -w @deskmates/agent-mcp` to refresh)", () => {
    const committed = JSON.parse(readFileSync(`${PACKAGE_DIR}openapi.json`, "utf8")) as unknown;
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });

  it("is OpenAPI 3.1 with one operation per table row and unique operation ids", () => {
    const doc = buildOpenApiDocument() as Doc;
    expect(doc.openapi).toMatch(/^3\.1\./);
    const ids = operationIds(doc);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(OPERATIONS.map((op) => op.operationId).sort());
  });

  it("maps every tool to documented operations, and documents nothing no tool uses", () => {
    const ids = new Set(operationIds(buildOpenApiDocument() as Doc));
    const used = new Set<string>();
    for (const tool of TOOLS) {
      expect(tool.operations.length, tool.name).toBeGreaterThan(0);
      for (const op of tool.operations) {
        expect(ids.has(op), `${tool.name} -> ${op}`).toBe(true);
        used.add(op);
      }
    }
    expect([...ids].filter((op) => !used.has(op))).toEqual([]);
  });

  it("documents only routes the Gateway's route manifest declares", () => {
    const manifest = readdirSync(ROUTE_POLICIES)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(`${ROUTE_POLICIES}${file}`, "utf8"))
      .join("\n");
    for (const op of OPERATIONS) {
      const key = policyKey(op);
      expect(manifest, key).toContain(`"${key}"`);
    }
  });
});

describe("the fake Gateway", () => {
  let gateway: FakeGateway;
  beforeAll(async () => {
    gateway = await startFakeGateway();
  });
  afterAll(async () => {
    await gateway.close();
  });

  it("serves exactly the documented operations", () => {
    expect(gateway.routes().sort()).toEqual(OPERATIONS.map(policyKey).sort());
  });
});
