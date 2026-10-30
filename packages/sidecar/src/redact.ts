// Redaction before anything enters the ledger or the model context (design v0.3 §3.2, §3.10).
// Pure functions; the run's own secrets (the model token) are passed in explicitly so an exact
// match is scrubbed even when it does not look like a token.

export const REDACTED = "[redacted]";

/** A shell-style value: a quoted string, or a run of characters up to whitespace or a quote. */
const VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)`;

/** `key=value` names whose value is a credential in a form body, a query string or JSON. */
const CREDENTIAL_PARAMS =
  "client_secret|password|passwd|secret|refresh_token|id_token|access_token|private_key|api_key|apikey";

type Replacement = string | ((match: string) => string);

/**
 * A replacement that applies `pattern` only inside the text its rule matched: the rule finds one
 * command (`curl …` up to a list operator), this redacts within it. A forward match keeps the
 * cost linear, where a lookbehind for the command name rescans the line at every position.
 */
function inCommand(pattern: RegExp, replacement: string): (match: string) => string {
  return (match) => match.replace(pattern, replacement);
}

const TEXT_PATTERNS: readonly [RegExp, Replacement][] = [
  // Authorization: Bearer <token>
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Anthropic-style and generic secret keys
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Tokens with a well-known prefix: GitHub, Slack, AWS access key ids, JWTs.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
  // KEY=value or KEY: value for well-known credential variables
  [
    /\b(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|MODEL_AUTH_TOKEN|GATEWAY_SECRETS_KEY)\s*[=:]\s*\S+/g,
    `$1=${REDACTED}`,
  ],
  // Any environment-style variable whose name ends in a credential word: `PGPASSWORD=…`,
  // `GITHUB_TOKEN=…`, `AWS_SECRET_ACCESS_KEY=…`, `MYSQL_PWD=…`. Upper case only, and the word
  // must end the name, so `MAX_TOKENS=` and `PWD=/work` pass.
  [
    new RegExp(
      String.raw`\b([A-Z0-9_]*(?:PASSWORD|PASSWD|_PWD|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY))\s*[=:]\s*${VALUE}`,
      "g",
    ),
    `$1=${REDACTED}`,
  ],
  // `curl -u user:pass`, `--user user:pass`: the user stays, the password goes. Only in a curl or
  // wget command (up to the next `;`, `|`, `&` or newline), so `docker run -u 1000:1000` and
  // `git push -u origin a:b` are left alone (#62).
  [
    /\b(?:curl|wget)\b[^\n;|&]*/g,
    inCommand(/(\s(?:-u\s*|--user[=\s]\s*)["']?)([^\s:"']+):[^\s"']+/g, `$1$2:${REDACTED}`),
  ],
  // `--password=…`, `--password …`, `--http-password=…` and similar, in any command. A next word
  // that is an option (`--password-stdin`, `--password -h`) is not a value.
  // Matching starts only where a run of word characters and dashes starts, so a long dashed run
  // is scanned once, not once per dash.
  [
    new RegExp(String.raw`(?<![\w-])(--[\w-]*password)(=|\s+)(?!-)${VALUE}`, "gi"),
    `$1$2${REDACTED}`,
  ],
  // `mysql -p<pw>`, `mysql -p <pw>`, `sshpass -p <pw>`: the value of `-p` in those commands.
  [
    /\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mariadb|mariadb-dump|sshpass)\b[^\n;|&]*/g,
    inCommand(new RegExp(String.raw`(\s-p)(\s*)(?!-)${VALUE}`, "g"), `$1$2${REDACTED}`),
  ],
  // Credentials in a URL's userinfo: `https://user:pass@host/` keeps the user and the host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"']+):[^/\s@"']+@/gi, `$1:${REDACTED}@`],
  // `client_secret=…` in a form body or anywhere else a credential parameter is assigned.
  [
    new RegExp(String.raw`(^|[^\w.-])((?:${CREDENTIAL_PARAMS})=)[^&\s"']+`, "gi"),
    `$1$2${REDACTED}`,
  ],
  // `"password": "…"` in a JSON body.
  [
    new RegExp(String.raw`(["'](?:${CREDENTIAL_PARAMS}|token)["']\s*:\s*["'])[^"']*`, "gi"),
    `$1${REDACTED}`,
  ],
  // The same JSON with its quotes backslash-escaped inside a shell string:
  // `-d "{\"password\":\"…\"}"`. The value ends at the next escaped quote.
  [
    new RegExp(
      String.raw`(\\["'](?:${CREDENTIAL_PARAMS}|token)\\["']\s*:\s*\\["'])(?:(?!\\["'])[^\n])*`,
      "gi",
    ),
    `$1${REDACTED}`,
  ],
  // `password: …` on a line, any case (a config line, a prompt answer). The upper-case variable
  // rule above already took `DB_PASSWORD: …`; the value runs to the next quote or newline.
  // It starts only where a run of word characters and dashes starts, as `--password` does.
  [/(?<![\w-])([\w-]*(?:password|passwd))[ \t]*:[ \t]*[^\s'"][^\r\n'"]*/gi, `$1: ${REDACTED}`],
  // Header lines and assignments whose whole value is sensitive; the optional opening quote makes
  // `document.cookie = "sid=…"` land here too, and the value stops at the next quote or newline so
  // a shell command keeps its shape.
  [/\b(cookie|set-cookie|authorization|x-api-key)\s*[:=]\s*["']?[^\r\n'"]+/gi, `$1: ${REDACTED}`],
  // Credentials carried in a query string: `…?access_token=xyz&next=/home` keeps its shape but
  // loses the value. Browser tool inputs and page URLs are full of these.
  [
    new RegExp(
      String.raw`([?&](?:amp;)?(${CREDENTIAL_PARAMS}|token|sig|signature|session|sid|auth|pwd)=)[^&\s"']+`,
      "gi",
    ),
    `$1${REDACTED}`,
  ],
  // A bare `key=` parameter is as often a sort or lookup key (`?key=sort`) as an API key, so its
  // value is redacted only when it looks like a credential: 16 or more characters, or 8 or more
  // with both a letter and a digit (#62). `api_key` and `apikey` are always redacted above.
  [
    /([?&](?:amp;)?key=)(?=[^&\s"']{16}|(?=[^&\s"']*[A-Za-z])(?=[^&\s"']*\d)[^&\s"']{8})[^&\s"']+/gi,
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
    out =
      typeof replacement === "string"
        ? out.replace(pattern, replacement)
        : out.replace(pattern, replacement);
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
