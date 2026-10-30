import { existsSync } from "node:fs";

// Empty filters preserve the complete layout gate. Shared styles/components, the guide,
// toolchain and missing fixtures cannot be narrowed to a feature safely.
export function layoutScope(files, event = "pull_request", exists = existsSync) {
  if (event !== "pull_request") return "";
  const features = new Set();
  for (const file of files) {
    if (/^(package(-lock)?\.json|tsconfig\.base\.json|vitest\.config\.[^/]+)$/.test(file))
      return "";
    if (!/^(packages\/(web|ui)\/|docs\/guide\/)/.test(file)) continue;
    const feature = /^packages\/web\/src\/features\/([a-z0-9-]+)\//.exec(file)?.[1];
    if (!feature || /\.css$/.test(file)) return "";
    features.add(feature);
  }
  for (const feature of features)
    for (const kind of ["tab", "row"])
      if (!exists(`packages/web/src/features/${feature}/${kind}-layout-cases.json`)) return "";
  return [...features].sort().join(",");
}
