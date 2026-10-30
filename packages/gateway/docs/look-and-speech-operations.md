# Look/OCR and speech operations (ADR-0040)

A bot reads an image, a PDF or an audio file in its workspace as text through a separate vision or
speech service. The sidecar tool reads and checks the file; the Gateway's operation proxy forwards
one request to the service the installation configured and returns the text; the Gateway never
starts an operation on its own and never retries. Code: `src/operations/`, configuration in
`src/config/operations.ts`, sidecar tools in `packages/sidecar/src/operation-tools.ts`.

## Configuration

Installation level only, in the Gateway's `.env` (see `.env.example`):

| Variable | Meaning |
| --- | --- |
| `VISION_OPERATION_URL`, `VISION_OPERATION_MODEL` | Both set: `look` and the `image_describe` tool are on. The URL is a base (`/v1/messages` or `/v1/chat/completions` is appended) or the full route. |
| `VISION_OPERATION_PROTOCOL` | `anthropic-messages` (default) or `openai-chat`. |
| `ASR_OPERATION_URL`, `ASR_OPERATION_MODEL` | Both set: `asr` and the `audio_transcribe` tool are on. `/v1/audio/transcriptions` is appended to a base URL. |
| `*_OPERATION_AUTH_TOKEN` | Optional Bearer for the service; kept in Gateway memory only. |
| `*_OPERATION_PRICE_USD` | USD per image or PDF page (vision) or per audio second (ASR). Empty: unpriced, cost NULL. `0`: a known zero. |
| `ASR_OPERATION_MAX_BYTES` | Default and ceiling 25 MiB. |
| `ASR_OPERATION_MAX_SECONDS` | Default 1800; checked before the call when the sidecar can read the duration (WAV). |

The stable deployment's local services (owner, 2026-10-14):

```
VISION_OPERATION_URL=http://10.0.0.5:8005
VISION_OPERATION_MODEL=qwen3.5-9b-vl
VISION_OPERATION_PRICE_USD=0
ASR_OPERATION_URL=http://10.0.0.5:8007/v1/audio/transcriptions
ASR_OPERATION_MODEL=<the model id the faster-whisper service expects>
ASR_OPERATION_PRICE_USD=0
```

When configured, every run's config carries `operations: { look?: { model, endpointSha256 },
asr?: {...} }` and the sidecar offers the matching tools. Nothing is probed (ADR-0040 decision 10);
whether the services read correctly has not been measured.

## Routes

Both under the sandbox listener's run-token scope; another run's token is 401.

- `POST /internal/runs/:runId/operations/look` — `{ mode: "ocr" | "describe", question?,
  mediaType, data (base64), unit: "image" | "page", source: { path, page? } }`. The Gateway
  re-sniffs the bytes, bounds them at 10 MiB, builds one request with a fixed instruction per
  mode, `max_tokens` 2048 and temperature 0, and answers `{ operationId, model, text, usage }`.
- `POST /internal/runs/:runId/operations/asr` — `{ mediaType, data, fileName, language?,
  durationSeconds?, source }`. Sent as multipart with `response_format=verbose_json`; answers
  `{ operationId, model, text, language, durationSeconds, usage }`.

Errors: `validation` (400) and `payload_too_large` (413) before any call; `budget_exhausted` (409)
when the workspace budget is spent; `operation_unavailable` (502) with `details.reason`
`timed_out`, `unreachable`, `answered_error` or `answered_malformed` after one call; `not_found`
(404) when the operation is not configured. Timeouts: 120 s per look call, 300 s per transcription.

## Records

`operation_requests` holds one row per forwarded or refused call: operation, mode, model,
endpoint hash, status, error code, unit (`image`, `page`, `audio_second`), quantity and whether
it was `computed`, `provider`-reported or `unknown`, input size and hash, tokens when reported,
latency and cost. No input bytes, output text or credential. Each call also writes a `log` event
(`source: "operation"`) on the run.

## Budget and Costs (ADR-0040 amendment A)

Each forwarded call is charged to the workspace budget as soon as its row is written, from the same
row: its `cost_usd` is known spend, an unknown quantity counts as unmeasured and a quantity with no
price as unestimated. Nothing is estimated for an operation unit, and a refusal charges nothing.
Weekly spend and the ceiling therefore include operations, and an exhausted workspace refuses the
next call with `budget_exhausted`. The Costs page adds the same rows to its money totals, the daily
chart and the bot and workspace rankings, lists them in a `by=operation` ranking (money only) and
shows one usage tile per unit; an operation without a price is shown as unpriced, never as zero.

## Sidecar tools

- `image_describe { path, mode?, question?, pages? }` reads a PNG, JPEG, GIF or WebP image (10 MiB)
  or a PDF (50 MiB) under `/work`, `/home` or `/tmp`. For a PDF it reads up to 10 pages per call
  (default the first 5); in `ocr` mode a page with a text layer (`pdftotext`) is returned without a
  call and only scanned pages are rendered (`pdftoppm`, 150 dpi) and sent, one call per page.
- `audio_transcribe { path, language? }` reads WAV, MP3, OGG, FLAC, WebM or M4A audio.

Both are L0, and both wrap results as `<untrusted source="operation:look|asr">`. On a run whose
model cannot see images (ADR-0023 amendment 2), the image and PDF deny notices and the prompt's
Images section name `image_describe`.
