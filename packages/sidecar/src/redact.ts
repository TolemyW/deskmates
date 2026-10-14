// Redaction before anything enters the ledger or the model context (design v0.3 §3.2, §3.10).
// Pure functions; the run's own secrets (the model token) are passed in explicitly so an exact
// match is scrubbed even when it does not look like a token.

export const REDACTED = "[redacted]";

const TEXT_PATTERNS: readonly [RegExp, string][] = [
  // Authorization: Bearer <token>
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Anthropic-style and generic secret keys
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  // KEY=value or KEY: value for well-known credential variables
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
    /([?&](?:amp;)?(access_token|token|api_key|apikey|key|sig|signature|session|sid|auth)=)[^&\s"']+/gi,
    `$1${REDACTED}`,
  ],
];

/**
 * Object keys that name a credential. The key is normalised to `snake_case` first, then matched
 * word by word, so the rule is "one of the key's words is a credential word" rather than a bare
 * substring test. That keeps `clientSecret`, `api_secret`, `secret_key`, `sessionid`, `passwd` and
 * `x-api-key` redacted while `runId`, `threadId`, `tokens_used` and `inputTokens` pass through:
 * `token` matches the whole word `token` only, never the `token` inside `tokens`.
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

/** Replace known secret values and anything that looks like a credential in free text. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Deep copy of `value` with every string passed through `redactText` and every property whose
 * key names a credential replaced wholesale. Non-plain objects are returned as-is.
 */
export function redactValue<T>(value: T, secrets: readonly string[] = []): T {
  return walk(value, secrets) as T;
}

function walk(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((v) => walk(v, secrets));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        isSensitiveKey(k) || (k === "data" && (value as Record<string, unknown>).sensitive === true)
          ? REDACTED
          : walk(v, secrets);
    }
    return out;
  }
  return value;
}
