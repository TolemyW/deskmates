import { isDeskmatesError } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { ENV_FILE_PATH, parseEnvFile, renderEnvFile } from "./env-file.js";

describe("env file rendering (injectEnv payload)", () => {
  it("renders sorted KEY=VALUE lines with a trailing newline", () => {
    const text = renderEnvFile({
      ANTHROPIC_AUTH_TOKEN: "tok-123",
      ANTHROPIC_BASE_URL: "http://host.docker.internal:8080/model",
    });
    expect(text).toBe(
      "ANTHROPIC_AUTH_TOKEN=tok-123\nANTHROPIC_BASE_URL=http://host.docker.internal:8080/model\n",
    );
  });

  it("keeps values verbatim, including '=' and spaces, without quoting", () => {
    const text = renderEnvFile({ A: "x=y z", B: "" });
    expect(text).toBe("A=x=y z\nB=\n");
  });

  it("renders an empty map as an empty file", () => {
    expect(renderEnvFile({})).toBe("");
  });

  it("rejects keys that are not shell identifiers", () => {
    for (const key of ["1ABC", "A-B", "A B", "", "A=B"]) {
      let err: unknown;
      try {
        renderEnvFile({ [key]: "v" });
      } catch (e) {
        err = e;
      }
      expect(isDeskmatesError(err) && err.code === "validation").toBe(true);
    }
  });

  it("rejects values containing line breaks or NUL, which would smuggle extra entries", () => {
    for (const value of ["a\nB=evil", "a\r", "a\0"]) {
      let err: unknown;
      try {
        renderEnvFile({ KEY: value });
      } catch (e) {
        err = e;
      }
      expect(isDeskmatesError(err) && err.code === "validation").toBe(true);
    }
  });

  it("round-trips through parseEnvFile", () => {
    const env = { ANTHROPIC_AUTH_TOKEN: "t", X: "a=b", _Y: "" };
    expect(parseEnvFile(renderEnvFile(env))).toEqual(env);
  });

  it("targets the tmpfs path the container mounts", () => {
    expect(ENV_FILE_PATH).toBe("/run/deskmates/env");
  });
});
