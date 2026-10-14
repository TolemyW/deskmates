# Workspace file uploads (ADR-0014 amendment A5)

An upload is a session of bounded parts on the operator listener (`api/file-upload-routes.ts`,
store `files/workspace-uploads.ts`, table `workspace_uploads`). Owners, Admins and Members of
the workspace may upload. Guests may not, and the route guard checks the caller's current role
on every request of the session.

| Route | What it does |
|---|---|
| `POST /api/workspaces/:id/uploads` `{name, sizeBytes, idempotencyKey?}` | Creates the session and an empty partial file (201). The same key returns the first session (200) |
| `PUT /api/workspaces/:id/uploads/:uploadId/parts?offset=<n>` | Appends one `application/octet-stream` part of at most 4 MiB, exactly at the received length |
| `POST /api/workspaces/:id/uploads/:uploadId/complete` | Commits it to `/work/uploads/<UTC date>/<name>` and returns the final path and SHA-256. Repeating the call returns the same result |
| `GET /api/workspaces/:id/uploads/:uploadId` | State and received bytes, for resuming |
| `DELETE /api/workspaces/:id/uploads/:uploadId` | Cancels a receiving session and removes its partial file |

Only the uploader sends parts and completes a session. The uploader, an Admin or an Owner reads
or cancels it. Anyone else gets 404. Each container operation is the fixed command
`deskmates-sidecar file-write` with its request on stdin (`packages/sidecar/src/file-write.ts`).
That command writes only under `/work/uploads/`, refuses a symbolic link at every directory on
the way and at the partial file, and never overwrites: a taken name gets `-2`, `-3` and so on.

## Answers

| Situation | Answer |
|---|---|
| Guest | 403 before any row or exec |
| Another workspace, another person's session | 404 |
| Workspace not running | 404 with `details.reason: "workspace_not_running"`; nothing starts |
| Part not at the received length | 409 `upload_offset_mismatch` with `details.receivedBytes` |
| Second part while one is being written | 409 `upload_busy` |
| Part past the declared size | 400 `upload_exceeds_declared_size` |
| Complete before every byte arrived | 409 `upload_incomplete` |
| Part on a cancelled, expired or completed session | 409 `upload_<state>` |
| Part with another content type | 415 |
| Part above 4 MiB | 413 (the body limit) |
| Workspace disk full | 507 `storage_exhausted`; the partial file is truncated back and the session resumes |
| Configured workspace quota exceeded | 413 `workspace_upload_quota` with `details.quotaBytes` |
| Link or non-directory on the way | 403 `upload_path_policy` |

## Limits that are not product caps

There is no per-file size cap (owner decision, 2026-10-13). These limits exist only because of
the transport and the platform:

- One part is at most 4 MiB (`WORKSPACE_FILE_UPLOAD_PART_BYTES`). A reverse proxy in front of the
  Gateway must accept a 4 MiB request body. nginx's default `client_max_body_size` of 1 MiB is
  too small.
- Each part costs one container exec plus about 5.6 MB of base64 on its stdin. Throughput is
  therefore bounded by exec latency, which is roughly one part per exec round trip.
- The workspace's disk is the real limit, and running out is reported as 507, not as a size
  refusal.
- `FILE_UPLOAD_WORKSPACE_QUOTA_BYTES` (unset by default) is an optional, disclosed per-workspace
  quota over the declared sizes of receiving and completed uploads.

A receiving session idle for 24 hours expires. Expiry happens the next time that workspace's
uploads are created or read while the workspace runs, and it removes the partial file.

## Records

Completion writes one `file.upload` audit event in the same transaction. The event holds the path,
size, digest and label, and never content. Creation, completion, cancellation and every refusal
write an info log line. A completed upload appears in the Files collection as `source: uploaded`,
`verification: input` with an `upload` reference. An upload starts no run, posts no message and
touches no Knowledge, memory or task. The Web composer's attach button inserts the final path into
the draft. The bot sees the path only when the person sends the message.
