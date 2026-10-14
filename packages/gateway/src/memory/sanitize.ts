// Credentials never enter learned memory: a learned item's body is redacted before it is stored,
// gated or indexed (AGENTS.md, "redact tokens and cookies before anything enters the ledger").

export function sanitizeMemoryBody(raw: string): string {
  return raw
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(
      /\b(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|MODEL_AUTH_TOKEN|GATEWAY_SECRETS_KEY)\s*[=:]\s*\S+/gi,
      "$1=[redacted]",
    )
    .replace(
      /\b(cookie|set-cookie|authorization|x-api-key)\s*[:=]\s*["']?[^\r\n'"]+/gi,
      "$1: [redacted]",
    )
    .replace(
      /([?&](access_token|token|api_key|apikey|key|sig|signature|session|sid|auth)=)[^&\s"']+/gi,
      "$1[redacted]",
    )
    .trim();
}
