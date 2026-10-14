import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./env-file.js";

describe("parseEnvFile", () => {
  it("parses KEY=VALUE lines, skipping comments, blanks and malformed lines", () => {
    const text = [
      "# injected by the sandbox provider",
      "",
      "ANTHROPIC_BASE_URL=http://gateway:8080/model",
      "ANTHROPIC_AUTH_TOKEN='tok=with=equals'",
      'DESKMATES_EGRESS_ALLOWLIST="ops.example.test,*.example.test"',
      "not a pair",
      "=novalue",
      "1BAD=x",
    ].join("\n");
    expect(parseEnvFile(text)).toEqual({
      ANTHROPIC_BASE_URL: "http://gateway:8080/model",
      ANTHROPIC_AUTH_TOKEN: "tok=with=equals",
      DESKMATES_EGRESS_ALLOWLIST: "ops.example.test,*.example.test",
    });
  });
});
