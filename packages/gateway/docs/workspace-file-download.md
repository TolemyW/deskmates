# Workspace file download (ADR-0014)

`GET /api/workspaces/:id/files?path=<absolute path>` (operator listener only, `file-routes.ts`)
returns one file as `application/octet-stream` with `Content-Disposition: attachment`,
`X-Content-Type-Options: nosniff` and `Cache-Control: no-store`: the file's bytes at request
time. The Gateway refuses a path that is not absolute, uses a character outside
`[A-Za-z0-9._\-/]`, has a `..` segment, or is not under `/work/` or `/home/<bot>/` for a bot of
that workspace (403 `forbidden`) before any exec. The read is `deskmates-sidecar file-read` with
`{path, botNames, maxBytes}` on stdin; the container resolves links with `realpath`, so a link
into `/profile` is refused there. Larger than `FILE_DOWNLOAD_MAX_BYTES` (default 1 GiB) is 413
`payload_too_large`; a missing file is 404 with `details.reason: "file_not_found"`. The route uses
`SandboxRegistry.peek` only: a stopped workspace is 404 with `details.reason:
"workspace_not_running"` and nothing starts. A timeout, a non-zero exit with an unknown code, or
malformed output is 503 `sandbox_unavailable`, never a partial file. Downloads do not take a lane.
Every download writes an info log line `workspace file downloaded` with workspace id, path, byte
count and operator identity (`operator`, the one identity the shared operator token gives);
refusals log `workspace file download refused` with the reason. No run event is written.
