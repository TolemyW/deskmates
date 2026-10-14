// Read-only pinned-source verification with in-memory provider responses. No server or OAuth flow.
// Usage: node --experimental-transform-types verify-drive-pinned.mjs <pinned-checkout> <output-dir>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [sourceArg, outputArg] = process.argv.slice(2);
assert(sourceArg && outputArg, "Explicit source checkout and output directory required");
const source = resolve(sourceArg), output = resolve(outputArg);
const revision = "4505aed0c75b719fd13810d9cef00940fb05e16d";
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(), revision);
assert.equal(execFileSync("git", ["diff", "--name-only", "HEAD", "--", "src"], { cwd: source, encoding: "utf8" }).trim(), "");
const load = (path) => import(pathToFileURL(join(source, path)).href);
const { provider } = await load("src/providers/googledrive/definition.ts");
const { executors, credentialValidators } = await load("src/providers/googledrive/executors.ts");
const { executeAction } = await load("src/core/execution.ts");
const sourceRequire = createRequire(join(source, "package.json"));
const { Validator } = await import(pathToFileURL(sourceRequire.resolve("@cfworker/json-schema")).href);
const { validateActionInput } = await load("src/core/validation.ts");
const { createCatalogStore } = await load("src/catalog-store.ts");
const { OAuthClientConfigService } = await load("src/oauth/oauth-client-config-service.ts");
const { isSafeFileId } = await load("src/server/files/transit-file-store.ts");
const { setDefaultGuardedFetchDnsLookup } = await load("src/core/guarded-fetch.ts");
const scope = "https://www.googleapis.com/auth/drive.file";
const config = new OAuthClientConfigService({ catalog: createCatalogStore([provider]), origin: "https://runtime.example.test", store: {
  get: async () => undefined, list: async () => [], set: async () => { throw Error("No persistence allowed"); }, delete: async () => { throw Error("No persistence allowed"); },
} });
assert.throws(() => config.normalizeConfig("googledrive", { clientId: "synthetic", clientSecret: "synthetic", requestedScopes: [scope] }), /scope not declared/);
assert.deepEqual(config.normalizeConfig("googledrive", { clientId: "synthetic", clientSecret: "synthetic", requestedScopes: ["https://www.googleapis.com/auth/drive"] }).requestedScopes, ["https://www.googleapis.com/auth/drive"]);
const actions = provider.actions.filter((a) => ["files.list", "files.get", "files.create"].includes(a.name));
assert.equal(actions.length, 3);
const action = (name) => actions.find((a) => a.name === name);
const text = "Deskmates M4 synthetic Drive acceptance artifact.\n";
const metadata = { id: "synthetic-file", name: "deskmates-m4-pinned.txt", mimeType: "text/plain", parents: ["dedicated-folder"], size: String(Buffer.byteLength(text)), trashed: false };
const requests = [];
const originalFetch = globalThis.fetch;
// All outbound transport is replaced. DNS is deterministic but still passes the public-address guard.
setDefaultGuardedFetchDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  assert.equal(url.origin, "https://www.googleapis.com");
  assert.equal(request.headers.get("authorization"), "Bearer synthetic-no-real-token");
  const method = request.method;
  requests.push({ method, pathname: url.pathname, query: Object.fromEntries(url.searchParams) });
  if (url.pathname === "/drive/v3/about") return Response.json({ user: { emailAddress: "synthetic@example.test", displayName: "Synthetic" } });
  if (url.pathname === "/upload/drive/v3/files") {
    assert.equal(method, "POST");
    const body = Buffer.from(await request.arrayBuffer()).toString("utf8");
    assert(body.includes('"parents":["dedicated-folder"]'));
    assert(body.includes(text));
    return Response.json(metadata);
  }
  assert.equal(method, "GET");
  if (url.pathname === "/drive/v3/files") return Response.json({ files: [metadata] });
  assert.equal(url.pathname, "/drive/v3/files/synthetic-file");
  if (url.searchParams.get("alt") === "media") return new Response(text);
  return Response.json(metadata);
};
const transitId = "0123456789abcdef0123456789abcdef.txt";
assert(isSafeFileId(transitId));
assert(!isSafeFileId("../escape.txt"));
const context = {
  getCredential: async () => ({ authType: "oauth2", accessToken: "synthetic-no-real-token", tokenType: "Bearer", profile: { accountId: "synthetic", displayName: "Synthetic", grantedScopes: [scope] }, metadata: {} }),
  transitFiles: { maxBytes: 1048576, create: async (file) => {
    assert.equal(await file.text(), text);
    return { fileId: transitId, downloadUrl: `https://runtime.example.test/api/files/${transitId}`, sizeBytes: file.size, name: file.name, mimeType: file.type };
  } },
};
const results = [];
try {
  for (const [name, input] of [
    ["files.list", { q: "'dedicated-folder' in parents and trashed = false", pageSize: 5 }],
    ["files.get", { fileId: "synthetic-file" }],
    ["files.create", { name: metadata.name, mimeType: "text/plain", parents: ["dedicated-folder"], text }],
    ["files.get", { fileId: "synthetic-file", alt: "media" }],
  ]) {
    assert.equal(validateActionInput(action(name), input).valid, true);
    const result = await executeAction(action(name), executors[action(name).id], input, context);
    assert.equal(result.ok, true, JSON.stringify(result));
    const outputValidation = new Validator(action(name).outputSchema, "2020-12", false).validate(result.output);
    assert.equal(outputValidation.valid, true, JSON.stringify(outputValidation.errors));
    results.push({ actionId: action(name).id, input, result });
  }
  assert.deepEqual(results[1].result.output.parents, ["dedicated-folder"]);
  assert.deepEqual(results[2].result.output.parents, ["dedicated-folder"]);
  assert.equal(results[3].result.output.file.downloadUrl, `https://runtime.example.test/api/files/${transitId}`);
  assert.equal(results[3].result.output.downloadUrl, undefined);
  assert.equal(validateActionInput(action("files.create"), { parents: "wrong-type" }).valid, false);
  assert.equal(validateActionInput(action("files.get"), {}).valid, false);
  assert.equal(validateActionInput(action("files.create"), { unrecognized: true }).valid, false);
  const profile = await credentialValidators.oauth2({ accessToken: "synthetic-no-real-token" }, { fetcher: globalThis.fetch });
  assert.equal(profile.profile.accountId, "synthetic@example.test");
} finally {
  globalThis.fetch = originalFetch;
  setDefaultGuardedFetchDnsLookup(undefined);
}
const sourceFiles = ["src/providers/googledrive/definition.ts", "src/providers/googledrive/scopes.ts", "src/providers/googledrive/actions.ts", "src/providers/googledrive/executors.ts", "src/oauth/oauth-client-config-service.ts", "src/core/execution.ts", "src/server/files/transit-file-store.ts", "src/mcp.ts"];
const hashes = {};
for (const file of sourceFiles) hashes[file] = createHash("sha256").update(await readFile(join(source, file))).digest("hex");
const definitions = actions.map(({ id, service, operationType, requiredScopes, inputSchema, outputSchema }) => ({ id, service, operationType, requiredScopes, inputSchema, outputSchema }));
await mkdir(output, { recursive: true });
await writeFile(join(output, "drive-pinned-schemas.json"), JSON.stringify({ revision, definitions }, null, 2) + "\n");
await writeFile(join(output, "drive-pinned-results.json"), JSON.stringify({ revision, mode: "pinned executors + full input validation + mock outbound HTTP; no Google authorization", declaredOAuthScopes: provider.auth[0].scopes, driveFileConfigAccepted: false, driveFileSyntheticExecutorPassed: true, realGooglePassed: false, sourceHashes: hashes, requests, results }, null, 2) + "\n");
console.log(JSON.stringify({ revision, actionSchemas: definitions.length, successfulExecutions: results.length, driveFileConfigAccepted: false, driveFileSyntheticExecutorPassed: true, realGooglePassed: false }));
