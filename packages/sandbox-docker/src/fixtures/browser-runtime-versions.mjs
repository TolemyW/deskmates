// T2 evidence: resolve each tool's actual driver, rather than npm ls's global depth-zero view.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const tools = {};
for (const name of ["@playwright/mcp", "@playwright/cli"]) {
  const file = `/opt/deskmates/node_modules/${name}/package.json`;
  const metadata = JSON.parse(readFileSync(file, "utf8"));
  const resolve = createRequire(file);
  const drivers = {};
  for (const dependency of ["playwright", "playwright-core"]) {
    const installed = JSON.parse(
      readFileSync(resolve.resolve(`${dependency}/package.json`), "utf8"),
    );
    drivers[dependency] = {
      declared: metadata.dependencies[dependency],
      installed: installed.version,
    };
  }
  tools[name] = { version: metadata.version, drivers };
}
console.log(JSON.stringify({ tools }));
