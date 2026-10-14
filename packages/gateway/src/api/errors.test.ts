// T0: the DeskmatesError code -> HTTP status table the operator and sandbox listeners share.

import { DeskmatesError, type DeskmatesErrorCode } from "@deskmates/contracts";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerErrorHandler } from "./errors.js";

describe("error handler", () => {
  it.each<[DeskmatesErrorCode, number]>([
    ["not_found", 404],
    ["validation", 400],
    ["forbidden", 403],
    // ADR-0023 decision 1: a proxied request naming a model the run was not started on.
    ["model_not_selected", 403],
    ["token_rejected", 401],
    ["sandbox_unavailable", 503],
    // ADR-0014 decision 2: a workspace file over the download cap.
    ["payload_too_large", 413],
  ])("maps %s to %i with the stable body", async (code, status) => {
    const app = Fastify();
    registerErrorHandler(app);
    app.get("/x", async () => {
      throw new DeskmatesError(code, "refused", { why: "test" });
    });
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/x" });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ code, message: "refused", details: { why: "test" } });
    await app.close();
  });
});
