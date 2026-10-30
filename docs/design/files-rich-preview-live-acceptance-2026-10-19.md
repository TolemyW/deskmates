# Rich file preview: real Chromium acceptance

Date: 2026-10-19
Issue: #2; ADR-0014 amendments A3 and A6
Lab material: **2026-10-19 — Workspace files real-byte Chromium acceptance**

## Scope and environment

The lab loaded the production `WorkspaceFilePreview`, PDF.js worker, feature styles,
`createFilesApi` and HTTP transport through Vite. An isolated HTTP fixture server answered
the existing workspace-file route with real bytes, `206 Content-Range` responses and native
attachment downloads. The source base was `94992a6` (v0.7.6), plus the image-decoding error
handler described below. No stable database or service was modified, and no model was called.

Chromium `153.0.8010.12` ran at 1440 × 1000 and 390 × 844. Ten assertion groups passed.
Screenshots of the desktop PNG, PDF, Markdown and CSV and the mobile PNG, PDF and CSV were
recorded; the PNG desktop and PDF/CSV mobile views were visually inspected. This is browser
acceptance against a controlled transport, not a new Docker/Gateway or deployed-model result.
The final supplemental pass also recorded PNG, PDF, Markdown, CSV, JSON and HTML in dark mode
at both widths; the dark JSON desktop and PDF/CSV mobile images were visually inspected.

## Results

| Check | Observed result |
|---|---|
| PNG bytes and viewing controls | A real 800 × 600 PNG decoded from a revocable Blob URL. Zoom-in and zoom-out traversed every step through 400% and 25%; Fit restored the fitted view. |
| PDF bytes, worker and controls | A real two-page, 1,260,940-byte PDF rendered visible text and page graphics to canvas. Next, Previous and direct page entry worked; page 3 was rejected. Zoom traversed every step from 50% through 300%. |
| PDF range reads | Opening the PDF issued `bytes=0-1048575`, then `bytes=1048576-1260939`, using one preview identity. Neither request exceeded 1 MiB. |
| Markdown | Heading/emphasis rendered, local image used the workspace-file route, raw script stayed inert, and Source displayed the same bytes. The remote image made no request before the disclosure button. After clicking it, exactly one request omitted authorization and referrer; closing and reopening required the disclosure again. |
| CSV | The rendered table had three headers and two data rows. A quoted comma stayed in one cell; script-shaped text stayed literal. Source/Rendered switched correctly. |
| JSON | Real 117-byte JSON rendered a native collapsible tree. Root and nested objects expanded/collapsed, Source/Rendered used the same bytes without another range read, and script-shaped string content stayed inert. |
| HTML | The iframe had an empty sandbox attribute and displayed the fixture heading. Its script did not execute. The external image failed with Chromium's `csp` reason before the test network route was reached; script, nested frame and form did not gain network access. Source retained the original markup as text. |
| Oversized text | A 1,300,000-byte text file read one 1 MiB prefix and displayed the truncation notice. |
| Oversized/undecodable image and missing/invalid file | The 17,830,145-byte PNG stopped at exactly 16 MiB with an error. A corrupt PNG, a missing Markdown path (404) and an invalid PDF displayed errors while keeping Download enabled. Office remained download-only. |
| Native download | The browser downloaded the complete PDF through a same-origin attachment URL. Its saved bytes exactly equalled the fixture, with SHA-256 `a5ce98006d0879384f1953ea5340f56f2e2debe12691a5d4359f7f115f817fbe`. The HTTP log recorded one non-range 200 response with 1,260,940 bytes. |
| Mobile controls | At 390 px, PNG zoom-in/out/Fit, PDF Next/zoom-in/out and CSV Source/Rendered were clicked successfully. The drawer and every visible button stayed inside the viewport. |
| Dark mode | All six rich formats opened at 1440 px and 390 px with the dark color scheme. Image/PDF controls, text/HTML Source/Rendered and JSON expansion were clicked; the drawer stayed in the viewport. Twelve screenshots record the views. |

Across the final complete run, 56 range requests returned 24,184,951 bytes, plus one full PDF
download. The expected 404 was included in the request log. There were no uncaught page errors.
Chromium emits a request event even for a CSP-blocked image; the receipt therefore records
request failures and interception hits separately. Counting request events alone would
incorrectly classify that blocked image as a network disclosure.

## Repair and repeatable evidence

The image element did not report a browser decode failure. It now revokes the unusable Blob
URL and reports the existing translated `imageUnavailable` message through the preview error
surface. Download stays available. A colocated regression dispatches the image error and
checks the alert, URL revocation and enabled Download button; the real corrupt-PNG fixture
also passes in Chromium.

- `npm test -w packages/web -- workspace-file-preview.test.tsx`: 26 tests passed.
- `npm run typecheck -w packages/web`: passed.
- `biome check` on the two modified file-preview files: passed.
- Final lab runner SHA-256: `00bf375fc3df277ea734d89a6befb60948eda64b6d1720f11abe8ad122e5a5ce`.
- Final lab entry SHA-256: `36e36134de0124938d15886556a939a93725edfd77c442978889445e019f0c23`.
- Final JSON receipt SHA-256: `367536f98bb9f0ff8c2a7a2d8c686f0412c6ed57b0b3bead7ef288a311fb1b0a`.

The private lab material contains the runner, entry point, fixture generator, fixture hashes,
per-request HTTP log, expected blocked-request receipt, downloaded PDF and screenshots.
All data is synthetic. It does not cover every possible malformed/encrypted PDF, every image
codec, or native mobile browsers; the normal bounded fallback remains the contract for those
files. No remaining check in this issue requires a provider account or human review.
