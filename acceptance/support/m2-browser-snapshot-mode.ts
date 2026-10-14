import type { BrowserSnapshotMode } from "@deskmates/contracts";

export const DEFAULT_M2_BROWSER_SNAPSHOT_MODE: BrowserSnapshotMode = "explicit-v1";

/** Strict acceptance-only selector; production defaults remain owned by Gateway config. */
export function selectM2BrowserSnapshotMode(value: string | undefined): BrowserSnapshotMode {
  const selected = value?.trim() || DEFAULT_M2_BROWSER_SNAPSHOT_MODE;
  if (selected !== "explicit-v1" && selected !== "inline-v2") {
    throw new Error(
      `M2_BROWSER_SNAPSHOT_MODE must be explicit-v1 or inline-v2, got ${JSON.stringify(value)}`,
    );
  }
  return selected;
}
