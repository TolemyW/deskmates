# ADR-0014: Operators download a workspace file by path

Date: 2026-09-29
Status: Accepted (product owner, 2026-10-11; download, the Files collection and the rich-preview policy are accepted). Originally proposed from the owner's 2026-09-29 note "先做下载器"; A1 specifies the original bounded text preview, A2 the collection and A3 supersedes the original transfer and preview limits.
Builds on: ADR-0004 (the workspace is the trust boundary), ADR-0006 (operator routes on the operator listener)
Amendment A2 (workspace Files collection, issue #27 phase B): accepted by the owner on 2026-10-11. Amendment A3 (issues #44 and #45) is accepted design. Amendment A5 (issue #52, authenticated uploads) is proposed; its upload roles and its absence of a per-file size cap are the owner's 2026-10-13 decisions, the rest is engineering design awaiting review. Amendment A6 (issue #45, preview viewing controls and entry points) is proposed engineering design within A3's accepted policy.

## Context

Bots write results into the workspace (`/work/...`, `/home/<bot>/...`) and name those paths in thread messages. An operator reading the thread can see the path but has no way to get the file short of noVNC takeover or a shell on the host. The owner asked for a downloader first: it is a subset of a full viewer, half the work, and a later preview pane reuses the route.

What must not happen: exposing the browser profile (cookies), listing directories, rendering file content in the operator page (XSS), building a shell command from a path, or starting a stopped workspace as a side effect of a download.

## Decision

1. **One operator route, one file, as an attachment.** `GET /api/workspaces/:id/files?path=<absolute path>` on the operator listener returns the file with `Content-Disposition: attachment; filename="<basename>"`, `Content-Type: application/octet-stream` and `X-Content-Type-Options: nosniff`. No directory listing, route-level preview or server-side rendering. The response is the file's current bytes at request time, not the version that existed when the message was posted.

2. **Path policy.** The path must be absolute, contain only `[A-Za-z0-9._\-/]`, contain no `..` segment, and resolve (after symlinks, inside the container) to a regular file under `/work/` or under `/home/<bot>/` for a bot of that workspace. Everything else, including `/profile`, is refused with a typed `forbidden` error that names no filesystem detail beyond the policy. Files larger than 1 MiB are refused with `payload_too_large` (the cap is a guess; raised by a config value if the trial needs it).

3. **The container does the read through a fixed command.** The Gateway calls `provider.exec(handle, { cmd: ["deskmates-sidecar", "file-read"], stdin: JSON })` with the path in the JSON, never in a shell string. The command inside the container applies decision 2 with `realpath`, checks the size before reading, and returns base64 content on stdout. A non-zero exit or malformed output is a `sandbox_unavailable` error to the operator, not a partial file.

4. **A stopped workspace is reported, never started.** The route uses the cached sandbox handle only (`sandboxes.peek`); with none it answers "workspace is not running" and does nothing else. Reads do not take the bot's lane, so a download works while runs are active.

5. **The web app turns absolute workspace paths in messages into download links.** A path token starts with `/work/` or `/home/`, continues over `[A-Za-z0-9._\-/]`, and ends at the first other character, so full-width punctuation (`，` `。` `）`) and spaces end it; a trailing `.` is not part of the path. Relative paths are not recognised; the operator can tell bots in SOUL to write absolute paths. Clicking fetches the route with the operator credential in the `Authorization` header, then saves the blob through a temporary `<a download>`; the page never navigates to the file and never renders its content.

6. **Every download is logged.** The Gateway writes an info log line with workspace id, path, byte count and operator identity as the operator listener knows it. This is not a run event: no run is involved.

### Amendment A1: bounded text preview in the operator UI (2026-09-30)

7. **A preview may decode a small file in the browser as inert text.** The operator UI may call the same authenticated attachment route for paths that already pass decision 2. It offers preview only for `.txt`, `.md`, `.csv`, `.json` and `.log`, limits the preview to 256 KiB, rejects invalid UTF-8 and control bytes, and places the decoded text in a React text node or `<pre>`. Markdown is shown as source text; HTML, scripts, links in the file and any other file type are never rendered. The download button remains available when preview is unsupported or fails. The route, path policy, 1 MiB download limit, stopped-workspace refusal and audit log do not change. This is a view of current file bytes, not a frozen deliverable. A message path with spaces inside an enclosing quote or backtick stays plain text because decision 2 would refuse the full path; ordinary space-delimited prose keeps decision 5's token rule.

### Amendment A2: the workspace Files collection (2026-10-10, proposed)

Issue #27 asks for one place to find what bots produced, including intermediate Markdown, images and HTML, without a shell or a takeover. Decisions 1 to 7 give one file by a known path. A2 adds a read-only list of the paths the Gateway already knows about. It does not list directories and does not read the container to build the list. Uploads and rendered previews stay out of scope (see "Proposed follow-up: uploads and richer preview" below).

8. **The collection is built from registered references, not from the filesystem.** `GET /api/workspaces/:id/assets` on the operator listener returns workspace file paths that Gateway SQLite already holds as references in that workspace: (a) task artifact references (`tasks.artifacts_json`, ADR-0021 decision 4 and amendment 2), (b) message attachments whose `ref` is a workspace path, and (c) workspace paths named in bot-authored message bodies, which are the same tokens decision 5 turns into links. Human-authored message bodies (often instructions that name a path before it exists) and system messages (approval requests carry proposed actions) are not sources. A file nobody referenced does not appear, and "All" means all registered references, not every file on disk. The response names this scope as `scope: "registered-references"`, and the UI says so. A complete inventory of intermediate files would need a separate, bounded discovery contract. This amendment does not define one.

9. **One item per workspace and lexical path.** Every candidate path must pass the lexical half of decision 2 against the workspace's current bot names: absolute, allowed characters only, no `..`, and under `/work/` or `/home/<bot>/` for a bot of this workspace. Anything else is dropped before it reaches the response, including `/profile`, other workspaces' bot homes and malformed paths. The identity is the exact path string. Symlinks and case are not resolved, because resolving them would need the container. Two spellings of the same bytes therefore appear twice, while one path referenced many times appears once with all its references. The realpath, regular-file and size checks of decisions 2 and 3 still run when a listed item is previewed or downloaded, so a listed symlink into `/profile` is refused at read time like any other.

10. **Provenance is recorded, never inferred.** Each item carries its references, newest first and at most 20, plus the total count. A reference records its kind, time, thread and message, run, bot and task where known. A linked row that no longer exists is shown as unknown. Item `source` is `bot` when at least one reference ties the path to a bot run: a bot-authored message, or a task artifact that carries a run reference. That is a recorded claim that a bot produced or named the file. It is not proof of who wrote the current bytes. `uploaded` is reserved for the phase C upload path, and no item has it today. Every other item is `unknown`. Living under `/home/<bot>/` is never evidence of authorship.

11. **"Used in delivery" belongs to one task reference.** A task artifact reference on a task whose state is `delivered` or `accepted` is marked `usedInDelivery` and links that task. The collection never labels a file "accepted", whatever the task state, the path, the extension or a run's success. Several task references stay separate rows, and no global file status is derived from them (ADR-0021 decision 3).

12. **Current bytes, not a historical version.** Preview and download read the file's current bytes through decisions 1 to 4 and 7. A reference's time is when the Gateway recorded it, not the file's modification time, and the UI labels it "Last referenced". The listing reports no size, because size is known only after a read. A delivery reference does not promise that today's bytes are the bytes that were delivered.

13. **Bounded server pagination, type and source filters, and search.** The route takes `offset` (default 0), `limit` (default 25, at most 100), `type` (`all`, `documents`, `images`, `web`, `other`), `source` (`all`, `bot`, `uploaded`) and `q` (a case-insensitive substring of the path or a reference label, at most 200 characters). The type comes from the file extension through one table in `contracts`. Items are ordered by last reference time, newest first, then by path. The response carries `total`, `offset`, `limit` and the page. The Gateway reads at most 10,000 of the most recent references of each kind per request. When a kind reaches that cap, the response sets `truncated: true` and the UI shows it. The client resets to the first page when a filter or the search changes.

14. **Listing never touches the workspace, and it is logged.** The route runs SQL only. It never calls the sandbox provider (`peek`, `ensure`, `exec`), so listing works while the workspace is stopped and never starts it. Its policy matches decision 1's route: a Member of the workspace's tenant may read it, because every member sees every workspace (permission model C6, full visibility), and the tenant guard returns a uniform 404 for a workspace in another tenant. Run tokens get 401. Each listing writes one info log line with the workspace id, the actor label, the filters and the total. As with downloads, this is not a run event.

15. **The Files screen.** The web app's Files screen (`#/resources/files`) shows the collection as a list (Name, Type, Source, Last referenced) or a grid of type placeholders. It has type and source filters, search and 25-item pages with previous/next controls. A detail panel shows the location, the type, the size once a read has returned the bytes, and the references with links to their thread, run and task. It offers Download (decision 5's authenticated helper) and the inert text preview of decision 7. It states honestly when a preview is unsupported, when a file is missing, when the workspace is not running (the download route's `workspace_not_running`) and when provenance is unknown. Grid thumbnails are type placeholders. No file content is rendered as an image or as HTML. The screen offers no upload control.

### Amendment A3: faceted collection and safe rich preview (2026-10-11, accepted)

This amendment supersedes decisions 1 to 3 and 7 only where their transfer limit, buffering and
preview-type rules conflict with the decisions below. The path, stopped-workspace, current-bytes,
authentication, audit and registered-reference rules remain unchanged.

16. **Server facets follow the other filters.** Every collection response carries counts for all
file kinds and sources. A kind count applies search and source but ignores the selected kind; a
source count applies search and kind but ignores the selected source. `total` and `items` apply all
filters. The client resets to page one after every filter change, displays the active filters with
one Clear action, names them in an empty result and does not offer Uploaded while its count is zero.

17. **Bounded range transport replaces whole-file base64.** The fixed sidecar command accepts an
offset and bounded length and returns that byte range plus the regular file's current total size.
The Gateway streams a full download range by range and waits for downstream demand before reading
the next range; cancellation stops further reads. The browser starts a same-origin attachment
download instead of first building a Blob. A single file download is limited to 1 GiB. A range
preview may inspect a file larger than that limit, but one preview identity may read at most 64 MiB
over at most 64 requests and expires after the preview timeout. The Gateway and sidecar never hold
the whole file merely to transfer it.

18. **Type-specific preview remains untrusted.** Text, Markdown, CSV and TSV may show a bounded
prefix with a visible truncation marker. Markdown uses the React-element renderer and keeps raw
HTML literal. JSON is collapsible only when the complete bounded content parses; a truncated value
is source text. PDF uses bounded range reads and fails cleanly to source/download when encrypted,
non-linearized or otherwise unsupported. DOCX, XLSX and PPTX are download-only in the first version.

19. **Images are Blob-isolated and complete.** PNG, JPEG, WebP, GIF and SVG are fetched completely
within the preview budget, displayed only through a revocable Blob URL in an `<img>`, and rejected
when encoded-byte or decoded-pixel limits are exceeded. SVG is never injected into the DOM. If a
browser security check cannot prove that script and external fetches stay isolated, SVG falls back
to source/download.

20. **Markdown makes remote images an explicit per-file disclosure.** Same-workspace relative
images resolve only through the authenticated file route. An HTTPS remote image makes no request
until the operator clicks **Load remote images** for that file. Such requests carry no Deskmates
authorization header or explicit credentials, use `Referrer-Policy: no-referrer`, fail harmlessly
and are accompanied by a privacy warning. The choice is forgotten when the file preview closes.
Other schemes and protocol-relative URLs never load.

21. **HTML has an opaque, offline frame.** HTML is supplied as `srcdoc` to an iframe whose sandbox
has no `allow-same-origin`, scripts, forms or navigation. A document policy equivalent to
`sandbox; default-src 'none'` disables every network fetch and access to app credentials, storage,
the parent or the operator API. Source and download remain available.

### Amendment A4: Files lists verified formal results and human inputs (2026-10-13, proposed from the owner-confirmed contract of issue #74)

The owner confirmed on 2026-10-13 that Files is for formally delivered Bot results: intermediate
drafts, checkpoints and stage outputs stay in their chat, and naming or attaching a path must not
publish it. A bot's formal delivery is checked by the server and published automatically, with no
human confirmation. Files a person supplied as input keep their provenance. This amendment
supersedes decision 8's three sources and decision 10's `uploaded` reservation; decisions 9 and 11
to 21 (lexical identity, current-bytes preview and download, paging, facets, safe preview) stay.
ADR-0021 amendment 3 decision A3g defines the delivery that triggers publication.

22. **Three sources, none of them a mention.** `GET /api/workspaces/:id/assets` lists (a)
publication records (decision 24), (b) workspace-path attachments on human-authored messages,
shown as `source: uploaded` (a person supplied the file as input; there is still no upload route,
and these are not Bot results), and (c) legacy task artifact references on a delivered or accepted
task that has no publication for that path, shown as unverified (decision 26). Bot message bodies,
bot attachments, system messages, checkpoints and artifact references on tasks that are not
delivered are no longer sources: those paths stay links in their chat. The scope string becomes
`published-results-and-inputs`. Listing stays SQL only and never touches the workspace.

23. **The server verifies a formal artifact through the existing file surface.** Before a delivery
writes anything, the Gateway runs the fixed `deskmates-sidecar file-read` command in `digest` mode
for each artifact, with the request on stdin. The command applies decision 2 unchanged (lexical
policy, `realpath` under `/work` or a bot home of the workspace, no symlink escape, `/profile` and
every other path refused, regular file only, at most the download cap) and returns the file's size
and SHA-256 computed inside the container. The Gateway uses the cached handle only: a stopped
workspace is `workspace_not_running`, never started. Missing, refused, oversized, unreadable or
malformed results are typed refusals returned to the bot, and nothing is published. No command or
check named by the agent runs; agent prose that a check passed is not verification.

24. **A publication record is idempotent and attributable.** `file_publications` stores the
workspace, task, delivery, run, bot, path, label, size, SHA-256, the check identity
(`file-read-digest-v1`), the Gateway check time, the task scope version and the publish time. It is
unique on (task, path, digest): a retry, restart or concurrent identical delivery returns the
existing record and publishes nothing twice. A later delivery of the same task and path with a new
digest supersedes the earlier record, which keeps its row and gains `superseded_at`; Files shows
the current record and its count of earlier versions. Deleting a task (ADR-0021 A3e) keeps its
publications.

25. **A digest names the checked bytes; Deskmates keeps no snapshot.** Preview and download still read
current bytes (decision 12). The detail shows the checked size, digest and check time and says that
the current bytes may differ from the checked version. A snapshot store and a re-check action are
follow-ups, not part of this amendment.

26. **Verification state is explicit per item.** Each item carries `verification`: `verified` for a
publication, `unverified` for a legacy delivered artifact (no backfill, no guessed finality), and
`input` for a human-attached file. Only `verified` items carry a `publication` block. A legacy
accepted delivery is not relabelled verified, and no item says "accepted".

27. **Partial and non-file deliveries.** A partial delivery publishes its verified artifacts as
individual results without implying the task is complete; the item links its task and shows the
delivery kind. A non-file delivery publishes nothing and adds no placeholder item.

### Verification (amendment A4)

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 22 (amendment A4) | Publications, human attachments and legacy delivered artifacts are listed; bot message paths, bot attachments, checkpoints and artifacts of undelivered tasks are not; the scope is `published-results-and-inputs` | T1 `packages/gateway/src/api/file-collection-routes.test.ts` | Items per workspace (reported) |
| 23 (amendment A4) | Digest mode applies decision 2 and returns size and SHA-256; a missing file, a `/profile` symlink, a directory and an oversized file are refused; a stopped workspace is refused without `ensure`; nothing is published on any refusal | T0 sidecar `file-read.test.ts` ("digest"); T1 `packages/gateway/src/files/file-verification.test.ts`; T1 `api/task-deliver-routes.test.ts` | refused verifications by reason (reported) |
| 24 (amendment A4) | A repeated delivery publishes once; a new digest supersedes and keeps the old row; a deleted task's publications stay | T1 `api/task-deliver-routes.test.ts` ("publishes once", "supersedes") | none |
| 25 (amendment A4) | The detail shows checked size, digest and time and states that current bytes may differ | T0 Web `features/files/files.test.tsx` | none |
| 26 (amendment A4) | Items carry `verified`, `unverified` or `input`; legacy rows stay unverified | T1 `file-collection-routes.test.ts` ("legacy stays unverified"); T0 Web `features/files/files.test.tsx` | Share of unverified items (reported) |
| 27 (amendment A4) | A partial delivery's artifacts are listed with the delivery kind and the task stays undelivered; a non-file delivery lists nothing | T1 `api/task-deliver-routes.test.ts` | none |

### Amendment A5: authenticated workspace uploads (2026-10-14, proposed; issue #52)

The owner decided on 2026-10-13 that Owners, Admins and Members of a workspace may upload and
Guests may not, and that there is no fixed product per-file size limit. Uploads must still stream
with bounded memory, report storage and transport constraints truthfully and clean incomplete
writes. The rest of this amendment is engineering design for review. It supersedes the "Proposed
follow-up: uploads" section below, and it supersedes decision 15's "offers no upload control".
Decisions 1 to 27 are unchanged.

28. **Who uploads.** An Owner, Admin or Member of the destination workspace may upload. A
service principal is checked by its machine role, and the operator credential acts as Owner. The
route guard checks the caller's current role in that workspace on every request of an upload:
creation, every part and completion. A Guest gets 403 before any session row or byte exists. A
role change or a removal ends the person's session (ADR-0022), so their next request gets 401.
Signed in again, a person demoted to Guest gets 403, and a removed person cannot sign in. Either
way, no further byte is written. A caller without a role in the workspace, or from another
tenant, gets the uniform 404. Run tokens get 401. An upload session belongs to its
uploader's actor label. Another caller cannot send its parts or complete it and gets 404. The
uploader, an Admin or an Owner may cancel it. A5 adds no route that deletes a completed upload:
the file is an ordinary `/work` file that any bot or person of the workspace can change or remove
(ADR-0004). A delete action is a follow-up, not part of A5.

29. **Destination and naming.** Every upload lands in `/work/uploads/<UTC date YYYY-MM-DD>/`.
The client names only the file, never a directory, a bot home or `/profile`. The Gateway reduces
the name to its last segment after `/` or `\`. It keeps a final extension of 1 to 16 ASCII letters
and digits. In the stem it replaces every run of characters outside decision 2's set
`[A-Za-z0-9._-]` with `_`, and strips leading and trailing `.`, `_` and `-`, so a name is never
hidden, never an option and never `..`. The name keeps at most 120 characters including the
extension. The stem becomes `upload` when no letter or digit is left, for example for a name
written entirely in another script. The person's original name,
without control characters and at most 255 characters, is kept as the provenance label only, and
never becomes part of a path. Bytes are first written to
`/work/uploads/.partial/<upload id>.part`. The command creates that file with
`O_CREAT|O_EXCL|O_NOFOLLOW` and mode `0640`, without execute bits. `/work`, `/work/uploads`, the
date directory and `.partial` must be real directories. A symbolic link at any of them is
refused as `forbidden`, and so is a partial file that is not a regular file. Completion never
overwrites. Inside the container, the partial file is hard-linked to the first free name among
`<name>`, `<stem>-2.<ext>`, `<stem>-3.<ext>`, and so on. A hard link fails rather than replaces
when the name exists. The partial file is then unlinked, and the response returns the final
path.

30. **No product size cap and truthful storage limits.** No per-file product size cap exists.
The client declares the total size when it creates the upload. The Gateway refuses a part that
would go past that size, and completes only when the received bytes equal the declared size. An
operator may set `FILE_UPLOAD_WORKSPACE_QUOTA_BYTES`, which is unset by default, so no quota
applies. When it is set, the sum of declared sizes of a workspace's receiving and completed
uploads may not exceed it, and the refusal is `payload_too_large` with
`reason: "workspace_upload_quota"` and the configured number. This disclosed quota is proposed,
not an owner decision. A full disk in the container (`ENOSPC`, `EDQUOT`) truncates the partial
file back to its previous length and answers `storage_exhausted` (HTTP 507). The session stays
resumable. Transport constraint: one part is at most 4 MiB
(`WORKSPACE_FILE_UPLOAD_PART_BYTES`), and that is the Gateway's body limit for the part route. A
reverse proxy in front of the Gateway must accept a 4 MiB request body. That is a transport unit,
not a file cap. Each part costs one fixed-command exec, which bounds throughput, and the docs say
so.

31. **Streaming, progress, cancellation, retry and resume.** An upload is a session:
`POST /api/workspaces/:id/uploads` with `{name, sizeBytes, idempotencyKey?}` creates it and its
partial file. `PUT /api/workspaces/:id/uploads/:uploadId/parts?offset=<n>` appends one raw part
at exactly the received length. `POST .../:uploadId/complete` finishes it. `DELETE
.../:uploadId` cancels it, and `GET .../:uploadId` reports its state and received bytes. The
Gateway holds at most one part per request. Only one part per session may be in flight: a second
concurrent part gets 409 with `reason: "upload_busy"`. A part at the wrong offset gets 409 with
`reason: "upload_offset_mismatch"` and the received byte count, so a client resumes from there
after a lost response. The container command refuses a write whose offset is not the partial
file's current length, so the Gateway's count cannot drift from the bytes on disk. Progress is
received over declared bytes. The same `idempotencyKey` returns the first session and does not
create a second. Completing a completed session returns its result again. Cancelling removes the
partial file, and a cancelled or expired session refuses parts. A receiving session with no
activity for 24 hours expires. Expiry runs lazily when the workspace's uploads are next created
or read, and it removes the partial file only when the workspace is running. A stopped workspace
answers `workspace_not_running` to create, part, complete and cancel, and is never started. The
browser sends parts in sequence, reports progress per part, cancels with an `AbortController`
plus `DELETE`, and retries a failed part at most three times from the received count it reads
back.

32. **Types are not trusted and content is not executed.** Neither the declared content type
nor sniffed bytes decide anything. The part route accepts only `application/octet-stream`, and
the session stores no MIME type. Files classifies an upload by its extension, as for any path
(decision 13). Preview stays under amendment A3 and decision 18, and an accepted upload may be
download-only. No upload is executable, unpacked or interpreted. Archives stay single files. The
server runs no malware scan in A5. A scanning hook is a proposed follow-up. Bytes a person
uploaded are input data. A bot that reads them treats them as untrusted content, like a page.

33. **Records, provenance and audit.** `workspace_uploads` records the workspace, the uploader's
actor label and user id where known, the label, the declared and received sizes, the state
(`receiving`, `completed`, `cancelled`, `expired`), the final path, and the SHA-256 the command
computes over the committed file inside the container. It also records the idempotency key,
timestamps and the failure reason. The Gateway stores no file bytes. A completed upload is a
fourth Files source: `source: uploaded`, `verification: input`, and a reference of kind `upload`
that carries the uploader, label, time, size and digest. A later upload of the same name gets a
new path. A5 has no replacement or versioning. Completion writes one `file.upload` audit event in
the same transaction as the state change. The event records the upload id, path, size, digest and
label, and never content. Creation, cancellation and every refusal write one info log line.

34. **An upload is never an instruction.** An upload starts no run, posts no message, writes no
Knowledge or learned memory, and attaches to no task or delivery. A chat reference is an explicit
second act. The composer's attach control uploads the file, then inserts the final workspace path
into the person's draft. The path reaches the bot only when the person sends that message, as
ordinary human text that decision 5 turns into a link. Attaching a path to a task stays the task
submission's own `attachments` field.

35. **Cleanup.** Deleting a workspace removes its upload rows by cascade, and a permanent delete
removes its volumes. Removing an uploader keeps their rows and audit events as provenance under
the stored actor label. Completed files stay in `/work` until someone removes them. Files then
still lists the record, and download reports the file missing (decision 15). Cancel and expiry
remove partial files. The Gateway never deletes a completed upload's file.

### Verification (amendment A5)

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 28 (amendment A5) | A Guest gets 403 with no session row and no exec. A Member, Admin and Owner each complete a same-workspace upload. Another tenant's workspace and a removed member get 404 on the next part. Another uploader's session is 404. A demoted or removed person writes nothing more. A run token gets 401 | T1 `packages/gateway/src/api/file-upload-routes.test.ts` ("roles"); `route-policy.test.ts` manifest; `operator-auth.test.ts` (every operator route refuses a caller without the operator credential) | refused uploads by reason (log) |
| 29 (amendment A5) | Traversal, separators, hidden and Unicode names reduce to safe names under `/work/uploads/<date>/`. A symbolic link at `uploads`, the date directory, `.partial` or the partial file is refused. An existing name gets `-2` and is never overwritten | T0 `packages/contracts/src/workspace-upload.test.ts` (`sanitizeUploadName`); T0 sidecar `packages/sidecar/src/file-write.test.ts` on a real temp directory | none |
| 30 (amendment A5) | A fixture far above 10 MiB streams in parts without a size refusal, and the Gateway holds at most one part. A part past the declared size, an over-quota create and a disk-full write give their typed answers. Disk-full truncates back and the session resumes | T1 `file-upload-routes.test.ts` ("streams a large file", "quota", "storage exhausted"); T0 `file-write.test.ts` ("truncates on a failed write") | upload bytes per day (log) |
| 31 (amendment A5) | Wrong offset and concurrent parts give 409 with the received count. Idempotent create and complete work. Cancel removes the partial file, and later parts are refused. A stale session expires. A stopped workspace is refused without `ensure`. The browser driver retries and cancels | T1 `file-upload-routes.test.ts`; T0 Web `features/files/upload-driver.test.ts` | cancelled and expired uploads (log) |
| 32 (amendment A5) | A part with another content type gets 415. The session stores no MIME type. The partial file and final file have no execute bits | T1 `file-upload-routes.test.ts`; T0 `file-write.test.ts` | none |
| 33 (amendment A5) | A completed upload appears once in Files as `uploaded`/`input` with uploader, size and digest. One `file.upload` audit event without content is written | T1 `file-upload-routes.test.ts` ("lists and audits"); T1 `file-collection-routes.test.ts` | uploads per workspace (reported) |
| 34 (amendment A5) | An upload creates no run, message, Knowledge document, memory item or task delivery. The composer button inserts the path into the draft without sending | T1 `file-upload-routes.test.ts` ("no side effects"); T0 Web `features/files/upload-attach-button.test.tsx` | none |
| 28 to 31 (amendment A5), UI | Files shows Upload with a scope note, progress, failure with Retry (resuming the same session), Cancel and completion; a Guest sees no control | T0 Web `features/files/upload-attach-button.test.tsx`, `features/files/files.test.tsx`; desktop and 390 px visual check | Visual check pending |
| 35 (amendment A5) | Deleting the workspace removes upload rows. Cancel and expiry remove partial files | T1 `packages/gateway/src/db/schema-conventions.test.ts` (every `workspace_id` cascades); T1 `file-upload-routes.test.ts`; T0 `file-write.test.ts` | none |
| 28 to 32 end to end | A file uploaded through the routes into a real workspace image downloads byte-identical. A planted `uploads` symbolic link into `/profile` is refused | T2 `acceptance/m4-file-upload.container.test.ts` (needs a workspace image with this sidecar) | none |

### Amendment A6: preview viewing controls and every file-link entry point (2026-10-14, proposed; issue #45)

Amendment A3 settled what may be rendered and how many bytes a preview may read. Issue #45 also
asks for a paged PDF viewer with zoom, images that fit the panel with zoom, a Markdown source
toggle, a bounded CSV table, and the same preview wherever a file is linked from a chat or a task.
The owner's reopening comment requires that a chat-linked preview opens in a separate drawer that
leaves the conversation in place. A6 specifies these viewing controls. It changes no route, no
byte budget, no path rule and no isolation rule: decisions 17 to 21 apply unchanged to every view
below. The decisions are engineering design that follows the issue text and awaits owner review.

36. **Rendered and Source views.** A Markdown, HTML, JSON, CSV, TSV or SVG preview offers two
views: Rendered (the A3 renderer) and Source. Source shows the decoded bytes already read for that
preview as a React text node in a `<pre>`. It reads nothing more and renders nothing. It is how
decision 19 and 21's "source remains available" is offered without a download. Source is the only
view for a truncated JSON prefix (decision 18). An SVG source view decodes the same complete bytes
under the text rules (UTF-8, no control bytes). The view choice is per open preview and resets to
Rendered when the drawer closes, like decision 20's remote-image choice.

37. **CSV and TSV are a bounded table.** The decoded prefix is parsed by RFC 4180 rules: quoted
fields, doubled quotes and delimiters or line breaks inside quotes. The first record is the header
row (`<th scope="col">`). The table shows at most 200 data rows and 50 columns. A note states the
number of rows and columns shown and says when more rows, more columns or more bytes exist. When
the prefix is truncated, the last record, which may be cut, is dropped. Cells are text only: no
formula is evaluated, no link is made and no cell is interpreted as HTML. XLSX and other Office
files stay download-only (decision 18).

38. **Zoom and page navigation.** An image opens fitted to the panel and offers zoom out, zoom
in and Fit, from 25% to 400% of its natural size. A PDF opens fitted to the panel width and
offers previous and next page, a page number field and zoom from 50% to 300% of the fitted width.
A rendered PDF canvas is capped at 16 million device pixels; a larger zoom renders at the cap
instead of growing memory. Zoom never changes how many bytes are read, and decision 19's
decoded-pixel limit applies before any zoom.

39. **More inert text types and browser image types.** Source and configuration files
(`.yaml`, `.yml`, `.toml`, `.ini`, `.cfg`, `.conf`, `.xml`, `.py`, `.js`, `.mjs`, `.cjs`, `.ts`,
`.tsx`, `.jsx`, `.sh`, `.sql`, `.css`, `.go`, `.rs`, `.java`, `.c`, `.h`, `.cpp`, `.rb`, `.diff`,
`.patch`) preview as inert text under the text budget and its truncation marker. XML is never
parsed or rendered. AVIF and BMP images preview under decision 19. Any other type, including
Office files, archives and executables, offers only Download with the explicit "Preview
unavailable for this file type" state.

40. **One drawer at every entry point.** Every place the web app shows a workspace file path
offers the same preview and download controls: a path token in a chat message, the chat's
Files section, a task's saved artifact, a published file in a task's delivery history and the
Files detail panel. Preview opens the separate detail drawer of decision 15. The message, task or
list never expands inline. Closing the drawer returns focus to the control that opened it and
discards the read bytes, the view choice and any Blob URL.

### Verification (amendment A6)

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 36 (amendment A6) | Markdown, HTML, JSON, CSV and SVG show a Source view of the same bytes with no further range read; HTML source holds the script as text and mounts no script; truncated JSON offers no Rendered view; closing resets the view to Rendered | T0 Web `features/files/workspace-file-preview.test.tsx` ("source view") | none |
| 37 (amendment A6) | Quoted delimiters, doubled quotes and quoted line breaks parse as one cell; the header uses column headers; a file with more than 200 rows or 50 columns states what is shown; a truncated prefix drops its cut last record; a formula cell stays text | T0 Web `features/files/csv-table.test.ts`; `workspace-file-preview.test.tsx` ("bounded table") | none |
| 38 (amendment A6) | Image zoom steps stay within 25% to 400% and Fit restores the fitted view; PDF zoom stays within 50% to 300%, the page field rejects out-of-range pages, and the canvas never exceeds 16 million device pixels | T0 Web `features/files/preview-zoom.test.ts`; `workspace-file-preview.test.tsx` ("zoom") | none |
| 39 (amendment A6) | YAML, Python and XML preview as text; XML is not parsed; AVIF previews as a Blob image; DOCX, XLSX, ZIP and EXE stay download-only | T0 Web `features/files/workspace-file-preview.test.tsx` ("preview type policy") | preview failures by type (reported) |
| 40 (amendment A6) | A published file in a task's delivery history offers Preview and Download, which open the drawer; a chat path opens the drawer without expanding the message, and closing returns focus to the opener | T0 Web `features/tasks/tasks.test.tsx` ("delivery preview"); `features/files/workspace-file-preview.test.tsx` ("returns focus"); desktop and 390 px visual check | Manual Testbox acceptance pending |

## Alternatives

- Serve files through a static route on the workspace container: rejected; it would need a listener in the workspace and would expose the profile volume by default.
- Copy the file out with `docker cp` on the host: rejected; provider-specific and bypasses the container-side policy check.
- Signed download URLs so plain links work: rejected for now; the operator credential is already in every request the page makes, and a signed URL would be a second credential to redact from logs.

## Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | The route exists only on the operator listener, returns the attachment headers above, and a run token gets 401 | T1 `packages/gateway/src/api/file-routes.test.ts`; `operator-auth.test.ts` extension | none |
| 2 | A table of paths (`/work/a.md`, `/home/nova/out.csv`, `/profile/Cookies`, `/work/../profile/x`, `/etc/passwd`, `/home/other-workspace-bot/x`, a symlink from `/work` into `/profile`, a directory, a 1 MiB + 1 byte file, a path with `，`) gives the expected accept/refuse verdict and error code | T0 `packages/sidecar/src/file-read.test.ts` on a real temp directory (realpath needs a filesystem); T1 route test with a fake provider returning the command's verdicts | refused reads by reason (reported) |
| 3 | The exec request is `["deskmates-sidecar", "file-read"]` with the path only in stdin JSON; no shell is invoked | T1 route test asserts the `ExecRequest` shape; T0 command test | none |
| 4 | With no cached handle the route returns the "not running" error and the provider's `ensure`/`create` is never called | T1 route test with a spy provider | none |
| 5 | The path tokenizer table (ASCII path, path followed by `，`, `。`, `）`, `.`, space, newline; relative path not linked; `/home/` prefix; two paths in one line) matches expectations; clicking fetches with the `Authorization` header and never sets `window.location` | T0 `packages/web/src/features/files/path-links.test.ts` and a chat-pane test with a fake fetch | none |
| 6 | One log line per download with the named fields | T1 route test with a captured logger | downloads per day (reported) |
| 7 (amendment A1) | An allowed UTF-8 text file previews as escaped text within 256 KiB; HTML/binary/oversized/invalid UTF-8, stopped workspace and unsupported paths do not render, while download remains available | T0 `packages/web/src/features/files/workspace-file-preview.test.tsx` and `path-links.test.ts` | preview failures by reason (reported) |
| 1–4 end to end | A file written into `/work` of a real workspace image downloads byte-identical; `/profile/Cookies` and a `>1 MiB` file are refused; a stopped workspace is reported | T2 `acceptance/m3-file-download.container.test.ts` | none |
| 8 (amendment A2) | Task artifacts, message attachments with a workspace path and bot-authored message paths are listed. Human-authored bodies, system messages and unreferenced files are not. The response names `registered-references` | T1 `packages/gateway/src/api/file-collection-routes.test.ts` ("lists the three registered sources and nothing else"); T0 `packages/contracts/src/file-collection.test.ts` (`workspacePathTokens`) | Items per workspace (reported) |
| 9 (amendment A2) | `/profile/Cookies`, `/work/../profile/x`, `/etc/passwd`, another workspace's bot home and a path with a space never appear. A path referenced by a task, an attachment and two messages is one item with four references | T1 `file-collection-routes.test.ts` ("drops protected and malformed paths", "deduplicates by exact path") | none |
| 10 (amendment A2) | A bot message or a run-stamped task artifact gives `source: bot` with bot and run links. A human-only reference gives `unknown`. A deleted bot or run reads as unknown, never as a guessed name. No item is `uploaded` | T1 `file-collection-routes.test.ts` ("records provenance from bot runs", "shows unknown provenance honestly") | Share of items with unknown source (reported) |
| 11 (amendment A2) | Only task references on delivered or accepted tasks carry `usedInDelivery`. Two tasks referencing one path stay two references. No response field says "accepted" | T1 `file-collection-routes.test.ts` ("marks used in delivery per task reference"); T0 Web `features/files/files.test.tsx` | none |
| 12 (amendment A2) | The list carries no size or modification time. The detail panel labels times "Last referenced" and shows size only after a read | T0 Web `features/files/files.test.tsx` | none |
| 13 (amendment A2) | 30 items page as 25 + 5. `limit` above 100 or a bad `type`/`source`/`offset` is a 400. Type and source filters and search narrow `total`. The scan cap sets `truncated`. The Web resets to page 1 on a filter change | T1 `file-collection-routes.test.ts` ("pages 25 at a time", "filters by type and source", "refuses", "caps the scan"); T0 contracts `file-collection.test.ts` (`fileKindOf`, `parseFileCollectionQuery`); T0 Web `features/files/files.test.tsx` | none |
| 14 (amendment A2) | Listing a stopped workspace succeeds without any provider `attach`/`ensure`/`exec` call. Another tenant's workspace is 404, a run token 401, a Member 200. One log line per listing | T1 `file-collection-routes.test.ts` ("never touches the sandbox", "lets a Member read and hides another tenant's workspace", "logs one line per listing"); `operator-auth.test.ts` (run token 401); `route-policy.test.ts` manifest; `tenant-boundary.test.ts` DATA-01 walk | Listings per day (reported) |
| 15 (amendment A2) | List and grid, filters, search, paging, detail with download, inert preview, unsupported, missing-file, not-running and unknown-provenance states render; no upload control exists | T0 Web `features/files/files.test.tsx`; visual check in `docs/design/files-collection-visual-check-2026-10-10.md` | Live UI review pending |
| 16 (amendment A3) | Facet counts apply the other facets and search, active filters reset pagination and clear together, and Uploaded is hidden at zero | T1 Gateway `file-collection-routes.test.ts`; T0 Web `features/files/files.test.tsx` | none |
| 17 (amendment A3) | Full downloads are range-streamed with backpressure/cancellation, stop at 1 GiB, and preview identities stop at 64 MiB, 64 requests or timeout even for larger files | T0 sidecar `file-read.test.ts`; T1 Gateway `file-routes.test.ts`; T0 Web `workspace-file-preview.test.tsx` | preview refusals by budget reason (reported) |
| 18 (amendment A3) | Bounded text/Markdown/CSV prefixes say when truncated; truncated JSON stays source; PDF failure and Office files fall back without pretending to render | T0 Web `workspace-file-preview.test.tsx` | preview failures by type (reported) |
| 19 (amendment A3) | Raster and SVG previews require complete bytes, enforce byte/pixel limits, never inject SVG and revoke every Blob URL | T0 Web `workspace-file-preview.test.tsx`; browser security check | none |
| 20 (amendment A3) | Markdown makes no remote request before the per-file action; afterwards only HTTPS images load without app credentials or referrer | T0 Web `workspace-file-preview.test.tsx`; browser network-log check | none |
| 21 (amendment A3) | HTML frame has an opaque origin, no active sandbox capability and CSP denies network; source/download remain | T0 Web `workspace-file-preview.test.tsx`; browser security check | none |

## Consequences

- Sidecar gains a `file-read` subcommand next to `memory`; Gateway gains `file-routes.ts`; web gains `path-links.ts` and a download helper in the chat pane.
- Ships as a patch release after typecheck, lint, T0/T1 and T2 pass (`docs/runbooks/stable-release.md`).
- A3 replaces the whole-file Blob download path with bounded ranges and adds safe type-specific previews. Frozen delivered versions and uploads still need separate design work.
- Amendment A2 adds `contracts` types for the collection, a Gateway query module and `GET /api/workspaces/:id/assets`, and a Web Files screen. It adds no migration, no table and no container command. An unreferenced intermediate file stays undiscoverable until a bot names it, attaches it or delivers it. A full inventory needs its own discovery contract.

## Proposed follow-up: uploads (issue #27 phase C, superseded by amendment A5)

Amendment A5 replaces this section. It is kept for history: C3's 10 MiB cap was never approved,
and the owner removed it on 2026-10-13.

This section is a proposal for review. None of the upload items is implemented, and the Files screen offers no upload control. Before implementation, the following needs owner review and then a numbered amendment with Verification rows.

- **C1. Upload API.** `POST /api/workspaces/:id/uploads?name=<file name>` on the operator listener, with the raw bytes as the body (`application/octet-stream`) and an optional client idempotency key. Members may upload, matching the read policy. Run tokens get 401. The Gateway writes the file through a fixed `deskmates-sidecar file-write` command, with the request on stdin and never in a shell string, mirroring decision 3. A stopped workspace is refused with `workspace_not_running` and is never started.
- **C2. Destination.** Every upload lands under `/work/uploads/<YYYY-MM-DD>/<name>`, where `<name>` is reduced to decision 2's character set and keeps its extension. Clients cannot choose `/home/<bot>/`, `/profile` or any other root. The container rechecks with realpath that the destination directory is not a symlink out of `/work`.
- **C3. Limits.** A configurable size cap, proposed at 10 MiB, replies `payload_too_large` above it. A name is at most 200 characters. Executable bits are never set. Types are not restricted by the server, because type decides only preview, never execution.
- **C4. Collisions.** An upload never overwrites. An existing name gets a `-2`, `-3`, ... suffix before the extension, and the response returns the final path. Retrying with the same idempotency key returns the first result instead of a second copy.
- **C5. Records, audit and ownership.** A new table records uploader (`user:<id>`, `service:<id>` or `human:web`), path, size, SHA-256 and time. Its rows become a fourth collection source with `source: uploaded`. One log line is written per upload and per refusal. The uploader is provenance, not ownership: every workspace member and bot can read and change the file, as with any `/work` file (ADR-0004). Uploading starts no run, posts no message, publishes no Knowledge and changes no access. Attaching an upload to a chat or a task is a separate, explicit action.
- **Planned checks.** Route tests for size, name and collision handling, idempotent retry, a stopped workspace and run-token refusal. A sidecar `file-write` test on a real temp directory, including a symlinked `uploads` directory. An upload must start no run.

Verification clarification (2026-10-04): the preview row is labeled decision 7
(amendment A1), matching its numbered decision; no acceptance result changed.
