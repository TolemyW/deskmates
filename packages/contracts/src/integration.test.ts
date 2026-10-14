// T0: the integration contract (ADR-0013 item 6, Amendment 1). The tier table holds for read,
// write and destructive; an override lowers only a write, never a destructive action and never an
// action marked never lowerable; action ids, services and connection names parse as the Gateway
// and the runtime need them.

import { describe, expect, it } from "vitest";
import {
  INTEGRATION_ERROR_STATUS,
  INTEGRATION_TOOL_NAMES,
  NEVER_LOWERABLE_ACTIONS,
  integrationServiceOf,
  isIntegrationActionId,
  isIntegrationConnectionName,
  isIntegrationOperationType,
  isIntegrationService,
  tierForAction,
} from "./integration.js";

const LOWER = { lowerableToL1: true, neverLowerable: false };
const PINNED = { lowerableToL1: true, neverLowerable: true };
const NONE = { lowerableToL1: false, neverLowerable: false };

describe("tierForAction", () => {
  it("maps read to L0, write to L2 and destructive to L2 without an override", () => {
    expect(tierForAction("read")).toBe("L0");
    expect(tierForAction("write")).toBe("L2");
    expect(tierForAction("destructive")).toBe("L2");
    expect(tierForAction("write", NONE)).toBe("L2");
  });

  it("lowers a write to L1 only when the operator lowered it and did not pin it", () => {
    expect(tierForAction("write", LOWER)).toBe("L1");
    expect(tierForAction("write", PINNED)).toBe("L2");
  });

  it("never lowers a destructive action, whatever the override says", () => {
    expect(tierForAction("destructive", LOWER)).toBe("L2");
    expect(tierForAction("destructive", PINNED)).toBe("L2");
  });

  it("never raises or lowers a read", () => {
    expect(tierForAction("read", LOWER)).toBe("L0");
    expect(tierForAction("read", PINNED)).toBe("L0");
  });
});

describe("identifiers", () => {
  it("reads the service from an action id", () => {
    expect(integrationServiceOf("googledrive.permissions.create")).toBe("googledrive");
    expect(integrationServiceOf("gitea.list_my_repositories")).toBe("gitea");
    expect(integrationServiceOf("no-dot")).toBeUndefined();
    expect(isIntegrationActionId("slack.post_message")).toBe(true);
    for (const bad of ["", ".x", "slack.", "slack post", 7, "a".repeat(250)])
      expect(isIntegrationActionId(bad)).toBe(false);
  });

  it("accepts short lower-case connection names that stay inside the runtime's name rule", () => {
    expect(isIntegrationConnectionName("main")).toBe(true);
    expect(isIntegrationConnectionName("slack-bot_2")).toBe(true);
    for (const bad of ["", "-x", "Main", "a b", "a/b", "a.b", "x".repeat(33)])
      expect(isIntegrationConnectionName(bad)).toBe(false);
    expect(isIntegrationService("googledrive")).toBe(true);
    expect(isIntegrationService("Google Drive")).toBe(false);
  });

  it("knows the three operation types and nothing else", () => {
    for (const t of ["read", "write", "destructive"])
      expect(isIntegrationOperationType(t)).toBe(true);
    expect(isIntegrationOperationType("delete")).toBe(false);
  });
});

describe("constants", () => {
  it("lists the five tools in the ADR's order and the two never-lowerable Drive actions", () => {
    expect(INTEGRATION_TOOL_NAMES).toEqual([
      "integration_apps",
      "integration_connections",
      "integration_search",
      "integration_guide",
      "integration_execute",
    ]);
    expect(NEVER_LOWERABLE_ACTIONS).toEqual([
      "googledrive.permissions.create",
      "googledrive.permissions.update",
    ]);
  });

  it("maps each integration error to an HTTP status", () => {
    expect(INTEGRATION_ERROR_STATUS).toEqual({
      integration_unavailable: 503,
      integration_connection_not_allowed: 403,
      integration_not_adopted: 409,
      integration_protocol: 502,
    });
  });
});
