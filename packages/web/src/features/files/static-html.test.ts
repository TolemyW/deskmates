import { expect, it } from "vitest";
import { HTML_PREVIEW_POLICY, prepareHtmlPreview } from "./static-html.js";

it("preserves document styles, body attributes, local anchors and embedded raster images", () => {
  const result = prepareHtmlPreview(
    '<!doctype html><html lang="zh"><head><style>body{background:#123456}.card{display:grid}</style></head><body style="color:white"><a href="#matrix">Matrix</a><h1 id="matrix">Report</h1><img src="data:image/png;base64,aGVsbG8="></body></html>',
  );
  expect(result.document).toContain('lang="zh"');
  expect(result.document).toContain('style="color:white"');
  expect(result.document).toContain("body{background:#123456}");
  expect(result.document).toContain('href="#matrix"');
  expect(result.document).toContain('src="data:image/png;base64,aGVsbG8="');
  expect(result.document).toContain(HTML_PREVIEW_POLICY);
});

it("makes active and network markup inert, including nested templates, refresh and SVG mutation", () => {
  const result = prepareHtmlPreview(
    `<meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test"><link rel="stylesheet" href="https://evil.test/x"><script>parent.owned=true</script><iframe srcdoc="bad"></iframe><img src="https://evil.test/image" onerror="fetch('/api')"><template><script>bad()</script><img srcset="https://evil.test/x 2x"></template><svg><set attributeName="href" to="https://evil.test"/><image href="https://evil.test/x"/></svg><form action="/api"><input formaction="/api" onclick="bad()"></form><a href="javascript:alert(1)">bad</a>`,
  );
  for (const text of [
    "<script",
    "<iframe",
    "<base",
    "<link",
    'http-equiv="refresh"',
    "onerror=",
    "onclick=",
    "formaction=",
    "srcset=",
    "<set ",
    "javascript:",
  ])
    expect(result.document).not.toContain(text);
  expect(result.document).not.toContain("https://evil.test");
});

it("moves only explicit HTTP sources into safe parent-owned links without credentials", () => {
  const result = prepareHtmlPreview(
    '<a href="https://typesafe.ai/blog/jev">Official Jev</a><a href="https://openrouter.ai/">Second source</a><a href="https://u:p@private.test/">Secret</a><a href="data:text/html,hi">Data</a>',
  );
  expect(result.links).toEqual([
    { url: "https://typesafe.ai/blog/jev", label: "Official Jev" },
    { url: "https://openrouter.ai/", label: "Second source" },
  ]);
  expect(result.document).not.toContain('href="https:');
  expect(result.document).not.toContain("u:p@");
});
