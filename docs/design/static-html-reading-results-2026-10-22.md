# Static HTML reading results — 2026-10-22

The owner reported a plain, unstyled HTML preview in a narrow drawer and a published app URL
that their browser could not open. The owner selected static HTML reading at the existing
Deskmates address first, with no separate domain/certificate available. ADR-0014 amendment A8
records the presentation and isolation contract.

## Diagnosis

The reported HTML had embedded CSS and no scripts; the old preview's `default-src 'none'`
also disabled its inline styles. Its application publication reported available. From the
authoring machine the app hostname resolved, but normal TLS validation failed to trust its
issuer. No certificate check was bypassed and no system trust or server certificate changed.
This observation does not establish that every user's DNS or browser has the same state.

## Result

- Static previews preserve embedded styles, original document/body attributes, local section
  anchors and embedded raster images in the opaque frame. A DOM-free parse5 pass removes
  active markup and external resource/navigation attributes; CSP allows inline styles and data
  images only. Rendered content has no scripts, automatic external requests or parent authority.
- External HTTP(S) source references without credentials are listed separately, in document
  order, as explicit parent-owned links with no-referrer/noopener/noreferrer. Source and Download
  retain the original bytes; the generated HTML is not rewritten in the workspace.
- Chat file cards and the drawer offer Open full page. The reader's URL stays on the current
  signed-in operator origin (`#/resources/files?...&view=read`), uses the authenticated file
  range API and existing 4 MiB HTML limit, and switches source views without rereading. It
  requires no app-domain DNS or additional certificate and grants no anonymous access.
- Fit width preserves the report's responsive layout; Desktop width uses a 1120px canvas with
  horizontal scrolling inside the preview. This avoids forcing wide tables into narrow cells.
  Interactive JavaScript applications still use ADR-0035's isolated origins; their domain/trust
  configuration is not changed or claimed fixed by this static-reader work.

## Verification

The private lab record "Static HTML reading — 2026-10-22" holds the exact reported HTML,
credential-free diagnostic scripts, component fixture, browser checks and inspected screenshots.
Chromium verified the report's original dark background (rgb(13,17,23)), light text, local font
stack and 30px title at desktop size, and no page-level horizontal overflow at 390px. Desktop
mode measured 1120px. A separate hostile document produced zero network probes, zero scripts,
no refresh, no parent state change and denied parent-document/storage access. Local anchors
worked. The reader/drawer use actual source components and the report's real bytes against a
fake range API; no new source release was deployed and no model was run.

The Web package passed 245 files / 1,740 tests. The Files package passed 13 files / 113 tests,
including the final source-order regression. Root typecheck, lint, docs:check and the production
web build passed. T2 and a deployment of these changes were not performed; milestone gates
remain as previously recorded. Temporary preview files and the local browser/server were closed.
