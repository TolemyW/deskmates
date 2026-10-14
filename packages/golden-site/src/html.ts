// Tiny HTML helpers. The console is deliberately plain: stable ids, labels and headings so the
// accessibility tree the MCP snapshot sees is the same on every run.

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface PageOptions {
  title: string;
  body: string;
  /** Email of the signed-in user, shown in the header so tests can assert it. */
  user?: string;
}

export function page(opts: PageOptions): string {
  const nav = opts.user
    ? `<nav id="nav">
      <a href="/dashboard">Dashboard</a>
      <a href="/tickets">Tickets</a>
      <a href="/customers">Customers</a>
      <a href="/orders">Orders</a>
      <a href="/checkout">New order</a>
      <a href="/reports">Reports</a>
      <a href="/settings">Settings</a>
      <span id="current-user">Signed in as ${escapeHtml(opts.user)}</span>
      <form method="post" action="/logout" style="display:inline"><button id="logout" type="submit">Log out</button></form>
    </nav>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(opts.title)} - Galaxy Ops Console</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #222; }
  nav a { margin-right: 1rem; }
  .kpi { display: inline-block; border: 1px solid #ccc; padding: 1rem; margin: 0.5rem; min-width: 10rem; }
  .kpi .value { font-size: 2rem; font-weight: bold; }
  .error { color: #b00020; }
  .notice { background: #fff8e1; border: 1px solid #f0c000; padding: 1rem; }
  label { display: block; margin-top: 0.75rem; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: 0.25rem 0.5rem; }
</style>
</head>
<body>
<header><h1 id="app-title">Galaxy Ops Console</h1>${nav}</header>
<main>
${opts.body}
</main>
</body>
</html>
`;
}

export function errorBox(message: string | undefined): string {
  return message ? `<p class="error" role="alert" id="error">${escapeHtml(message)}</p>` : "";
}
