// One bounded image-input diagnostic. This bypasses the agent strategy and cannot establish
// browser task acceptance. Only a synthetic golden-site screenshot may be supplied.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";

const { values } = parseArgs({ options: {
  env: { type: "string" }, image: { type: "string" }, output: { type: "string" },
  model: { type: "string" },
} });
if (!values.env || !values.image || !values.output)
  throw new Error("Pass --env, --image (synthetic golden-site JPEG), and --output");
const config = parseEnv(readFileSync(resolve(values.env), "utf8"));
const bytes = readFileSync(resolve(values.image));
if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Expected a JPEG fixture");
const token = config.MODEL_AUTH_TOKEN;
const model = values.model ?? config.DEFAULT_MODEL;
if (!token || !config.MODEL_BASE_URL || !model) throw new Error("Missing model configuration");
const prompt = "Read this screenshot. What large numeric value and blue button label are visible? Return only a JSON object with number and button. If you cannot see the image, say so; do not guess.";
const report = {
  startedAt: new Date().toISOString(),
  model,
  imageSha256: createHash("sha256").update(bytes).digest("hex"),
  imageBytes: bytes.length,
  prompt,
  scope: "Single image-input diagnostic, not an agent task, strategy comparison, or milestone pass",
};
try {
  const response = await fetch(`${config.MODEL_BASE_URL.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: bytes.toString("base64") } },
      { type: "text", text: prompt },
    ] }] }),
    signal: AbortSignal.timeout(60_000),
  });
  report.status = response.status;
  const result = await response.json();
  report.responseModel = result.model;
  report.stopReason = result.stop_reason;
  report.text = (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  report.usage = result.usage;
  if (result.error) report.error = { type: result.error.type, message: result.error.message };
} catch (error) {
  report.error = String(error);
} finally {
  report.finishedAt = new Date().toISOString();
  const output = resolve(values.output);
  mkdirSync(dirname(output), { recursive: true });
  const safe = JSON.stringify(report, null, 2).split(token).join("[REDACTED]");
  writeFileSync(output, safe, { flag: "wx" });
  console.log(safe);
}
