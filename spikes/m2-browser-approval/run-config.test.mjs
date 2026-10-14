import assert from "node:assert/strict";
import test from "node:test";
import { selectSnapshotMode } from "./run-config.mjs";

test("parked-approval runner defaults strictly to explicit-v1", () => {
  assert.equal(selectSnapshotMode(undefined), "explicit-v1");
  assert.equal(selectSnapshotMode("  "), "explicit-v1");
  assert.equal(selectSnapshotMode("inline-v2"), "inline-v2");
  assert.throws(() => selectSnapshotMode("inline"), /explicit-v1 or inline-v2/);
});
