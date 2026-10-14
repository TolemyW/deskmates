// The Gateway's last line against a secret reaching a thread (design v0.3 §3.2, §3.10). The
// sidecar already redacts the `ToolAction` before it posts an approval request; this scrubs it
// again on arrival, because the approval card is the one place a tool input is shown to a human
// verbatim, and a sidecar that failed to redact must not be the only thing standing between a
// bearer token and the transcript.
//
// The patterns mirror `packages/sidecar/src/redact.ts` on purpose and the two are deliberately
// not shared: this one has to hold even when the sidecar's copy is old, wrong or absent, so it
// owns its own regexes. Pure, so it is a T0 unit.

export const REDACTED = "[redacted]";

const TEXT_PATTERNS: readonly [RegExp, string][] = [
  // Authorization: Bearer <token>
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Anthropic-style and generic secret keys
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  // KEY=value or KEY: value for the credential variables the sandbox is handed
  [
    /\b(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|MODEL_AUTH_TOKEN|GATEWAY_SECRETS_KEY)\s*[=:]\s*\S+/g,
    `$1=${REDACTED}`,
  ],
  // Header lines and assignments whose whole value is sensitive; the optional opening quote makes
  // `document.cookie = "sid=…"` land here too, and the value stops at the next quote or newline so
  // a shell command keeps its shape.
  [/\b(cookie|set-cookie|authorization|x-api-key)\s*[:=]\s*["']?[^\r\n'"]+/gi, `$1: ${REDACTED}`],
  // Credentials carried in a query string: `…?access_token=xyz&next=/home` keeps its shape but
  // loses the value. Browser tool inputs and page URLs are full of these.
  [
    /([?&](access_token|token|api_key|apikey|key|sig|signature|session|sid|auth)=)[^&\s"']+/gi,
    `$1${REDACTED}`,
  ],
];

/**
 * Object keys that name a credential. The key is normalised to `snake_case` first, then matched
 * word by word, so the rule is "one of the key's words is a credential word" rather than a bare
 * substring test. That keeps `clientSecret`, `api_secret`, `sessionid`, `passwd` and `x-api-key`
 * redacted while `runId`, `threadId` and `tokens_used` pass through: `token` matches the whole
 * word `token` only, never the `token` inside `tokens`.
 */
const SENSITIVE_KEY_WORDS =
  /(^|_)(secrets?|token|passwords?|passwd|cookies?|credentials?|api_?keys?|authorization|session_?id)(_|$)/;

/** `clientSecret` and `x-api-key` both become `client_secret` / `x_api_key`. */
function normaliseKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s.]+/g, "_")
    .toLowerCase();
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_WORDS.test(normaliseKey(key));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What `scrubSecretShaped` returns: the cleaned copy and how many places it had to touch. */
export interface ScrubResult<T> {
  value: T;
  /** One per string the patterns changed, plus one per property replaced on its key alone. */
  hits: number;
}

/**
 * A deep copy of `value` with every secret-shaped string replaced. `secrets` are exact values the
 * Gateway knows are its own — the upstream model token — so they go even when they look like
 * nothing in particular. Arrays and plain objects are walked; anything else is returned as-is.
 */
export function scrubSecretShaped<T>(value: T, secrets: readonly string[] = []): ScrubResult<T> {
  const counter = { hits: 0 };
  const out = walk(value, secrets, counter) as T;
  return { value: out, hits: counter.hits };
}

/** The text half on its own, for a caller that already holds one string. */
export function scrubText(
  text: string,
  secrets: readonly string[] = [],
): { text: string; hit: boolean } {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return { text: out, hit: out !== text };
}

function walk(value: unknown, secrets: readonly string[], counter: { hits: number }): unknown {
  if (typeof value === "string") {
    const scrubbed = scrubText(value, secrets);
    if (scrubbed.hit) counter.hits += 1;
    return scrubbed.text;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, secrets, counter));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        counter.hits += 1;
        out[k] = REDACTED;
      } else {
        out[k] = walk(v, secrets, counter);
      }
    }
    return out;
  }
  return value;
}
