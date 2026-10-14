export function selectSnapshotMode(value) {
  const selected = value?.trim() || "explicit-v1";
  if (selected !== "explicit-v1" && selected !== "inline-v2")
    throw new Error("snapshot-mode must be explicit-v1 or inline-v2");
  return selected;
}
