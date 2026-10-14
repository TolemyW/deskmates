// cgroup memory is workspace-wide; process RSS covers only this sidecar, not the SDK child.
export interface ResourceObservation {
  sidecarRssBytes: number;
  workspaceMemoryBytes?: number;
  workspaceMemoryPeakBytes?: number;
}
export async function readResourceObservation(
  read: (path: string) => Promise<string>,
  rss: () => number,
): Promise<ResourceObservation> {
  const value: ResourceObservation = { sidecarRssBytes: rss() };
  async function number(paths: string[]): Promise<number | undefined> {
    for (const path of paths) {
      try {
        const n = Number((await read(path)).trim());
        if (Number.isFinite(n) && n > 0) return n;
      } catch {
        /* cgroup v1/v2 or unavailable */
      }
    }
    return undefined;
  }
  const current = await number([
    "/sys/fs/cgroup/memory.current",
    "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  ]);
  const peak = await number([
    "/sys/fs/cgroup/memory.peak",
    "/sys/fs/cgroup/memory/memory.max_usage_in_bytes",
  ]);
  if (current !== undefined) value.workspaceMemoryBytes = current;
  if (peak !== undefined) value.workspaceMemoryPeakBytes = peak;
  return value;
}
