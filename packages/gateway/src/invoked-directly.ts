// Whether a module is the process's entry point. Node resolves symlinks for the main module, so
// `import.meta.url` names the real file while `process.argv[1]` keeps the path as typed; the stable
// deployment starts the Gateway through a `current -> releases/<v>` link, and comparing the two
// strings made it exit 0 without starting (2026-09-28, v0.2.4). Compare real paths instead.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function invokedDirectly(argv1: string | undefined, moduleUrl: string): boolean {
  if (typeof argv1 !== "string" || argv1 === "") return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
