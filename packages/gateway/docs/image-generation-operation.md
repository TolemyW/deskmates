# Image generation operation (ADR-0040 amendment B)

A bot asks the installation's self-hosted text-to-image service for images and gets files in its
own directory. The sidecar tool `image_generate` sends a bounded request; the Gateway's operation
proxy builds the one upstream request, forwards it once with no retry, checks the images and
returns them; the sidecar writes them. The Gateway never starts a generation on its own and never
fetches a URL. Code: `src/operations/` (route, adapter), configuration in
`src/config/operations.ts`, the tool in `packages/sidecar/src/operation-tools.ts` and the writer
in `packages/sidecar/src/operation-output.ts`.

## Configuration

Installation level only, in the Gateway's `.env` (see `.env.example`). Off unless both the URL
and the model are set.

| Variable | Meaning |
| --- | --- |
| `IMAGE_OPERATION_URL`, `IMAGE_OPERATION_MODEL` | Both set: the operation and the `image_generate` tool are on. `/v1/images/generations` is appended to a base URL; a URL that already ends in it is kept. |
| `IMAGE_OPERATION_AUTH_TOKEN` | Optional Bearer for the service; kept in Gateway memory only. |
| `IMAGE_OPERATION_PRICE_USD` | USD per generated image. Empty: unpriced (cost NULL, shown as unpriced on Costs). `0`: a known zero. |
| `IMAGE_OPERATION_DEFAULT_SIZE` | Size when a call names none; default `1024x1024`. |

The owner's ruling for the stable deployment (2026-10-17) is a local service on the GPU host,
priced as known zero:

```
IMAGE_OPERATION_URL=http://<gpu-host>:<port>
IMAGE_OPERATION_MODEL=<the model id the image service expects>
IMAGE_OPERATION_PRICE_USD=0
```

The service must speak the OpenAI-compatible image generations protocol and answer `b64_json`.
No particular server has been verified; live verification is pending on the stable host.

## Route

`POST /internal/runs/:runId/operations/image_generation` under the sandbox listener's run-token
scope; another run's token is 401. Body `{ prompt, size?, count? }`: prompt 1 to 4000 characters,
size `<width>x<height>` with each side 256 to 2048 and a multiple of 64, count 1 to 4 (default 1).
The upstream body is always `{ model, prompt, n, size, response_format: "b64_json" }` with the
configured model. Each returned image must be PNG, JPEG or WebP of at most 16 MiB; the answer is
`{ operationId, model, images: [{ mediaType, data, bytes, sha256, width, height }], revisedPrompt,
usage }`, with `width`/`height` read from the header or `null`.

Errors: `validation` (400) before any call; `budget_exhausted` (409); `operation_unavailable`
(502) with `details.reason` `timed_out`, `unreachable`, `answered_error` or `answered_malformed`
(including a `url`-only answer, which is never fetched); `not_found` (404) when not configured.
Timeout: 300 s.

## Records, budget and Costs

One `operation_requests` row per call: operation `image_generation`, unit `image`, quantity the
number of images returned (`computed`), unknown on a failure, the prompt's byte size and hash (not
its text), latency and cost. The call is charged to the workspace budget and shown on Costs as for
look and asr ([look-and-speech-operations.md](look-and-speech-operations.md)).

## The tool

`image_generate { prompt, size?, count? }` is L1: it writes new files only in the bot's own
directory, `/work/bots/<bot>/images/<UTC time>-<id>-<n>.<ext>`, creating each exclusively, and
refuses an images directory that links out of the bot's directory. The result lists each path with
type, pixel size, bytes and SHA-256, never an image block; a revised prompt is wrapped as
`<untrusted source="operation:image_generation">`. On a run whose model cannot see images
(ADR-0023 amendment 2) the result says so and names `image_describe` when it is offered.
