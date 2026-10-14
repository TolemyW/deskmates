// Read Chromium's live CDP target list from inside an isolated workspace container.
// The acceptance case uses this before and after approval resume so persisted sidecar metadata
// is checked against the browser itself, rather than treated as proof that a tab still exists.
const response = await fetch("http://127.0.0.1:9222/json/list");
if (!response.ok) throw new Error(`CDP target list returned ${response.status}`);
const targets = await response.json();
const pages = targets
  .filter((target) => target.type === "page")
  .map(({ id, title, type, url }) => ({ id, title, type, url }));
process.stdout.write(JSON.stringify(pages));
