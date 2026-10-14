// In-memory `SidecarFs` for T1 tests.

import type { SidecarFs } from "../deps.js";

export interface MemoryFs extends SidecarFs {
  files: Map<string, string>;
  /** Directories `mkdir` created, in order, so a test can see the screenshot dir was made. */
  dirs: string[];
}

export function createMemoryFs(initial: Record<string, string> = {}): MemoryFs {
  const files = new Map(Object.entries(initial));
  const dirs: string[] = [];
  return {
    files,
    dirs,
    readFile: async (path) => {
      const v = files.get(path);
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return v;
    },
    exists: async (path) => files.has(path),
    appendFile: async (path, text) => {
      files.set(path, (files.get(path) ?? "") + text);
    },
    writeFile: async (path, text) => {
      files.set(path, text);
    },
    mkdir: async (path) => {
      if (!dirs.includes(path)) dirs.push(path);
    },
    rm: async (path) => {
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      }
      const at = dirs.indexOf(path);
      if (at >= 0) dirs.splice(at, 1);
    },
  };
}
