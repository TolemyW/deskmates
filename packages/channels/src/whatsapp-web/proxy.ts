/** Standard operator-host proxy settings. Never pass these values to a browser or log. */
export function whatsappProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exclusions = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase());
  if (
    exclusions.some(
      (value) =>
        value === "*" ||
        value === "web.whatsapp.com" ||
        (value.startsWith(".") && "web.whatsapp.com".endsWith(value)),
    )
  )
    return undefined;
  const raw =
    env.WHATSAPP_WEB_PROXY_URL?.trim() ||
    env.https_proxy?.trim() ||
    env.HTTPS_PROXY?.trim() ||
    env.http_proxy?.trim() ||
    env.HTTP_PROXY?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid WhatsApp proxy URL");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("WhatsApp proxy must use HTTP(S)");
  return raw;
}
