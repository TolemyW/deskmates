import net from "node:net";

// DNS-over-HTTPS name resolution for the egress proxy (ADR-0010 decision 4a). Some hosts intercept
// every plain DNS query on port 53 and answer with fake IPs, which the proxy correctly denies as
// non-public. A JSON DoH endpoint addressed by IP literal bypasses that interception: no name has
// to be resolved to reach the resolver itself. Any doubt about an answer fails closed.

export const DOH_TIMEOUT_MS = 5000;

// DNS record type -> address family. Every other row (CNAME, DNAME, RRSIG, ...) is ignored; the
// resolver has already followed the chain and the final A/AAAA rows are the only usable data.
const ADDRESS_TYPES = new Map([
  [1, 4],
  [28, 6],
]);

export function parseDohUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DoH URL is not a URL");
  }
  if (url.protocol !== "https:") throw new Error("DoH URL must use https");
  if (url.username !== "" || url.password !== "")
    throw new Error("DoH URL must not carry credentials");
  // A hostname would itself be resolved through the intercepted resolver.
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0) {
    throw new Error("DoH URL host must be an IP literal");
  }
  return url;
}

function addressRows(body) {
  if (body === null || typeof body !== "object") throw new Error("DoH answer is not an object");
  if (body.Status !== 0) throw new Error(`DoH status ${String(body.Status)}`);
  if (body.Answer === undefined) return [];
  if (!Array.isArray(body.Answer)) throw new Error("DoH Answer is not a list");
  const answers = [];
  for (const row of body.Answer) {
    const family = ADDRESS_TYPES.get(row?.type);
    if (family === undefined) continue;
    if (typeof row.data !== "string" || net.isIP(row.data) !== family) {
      throw new Error("DoH address record is malformed");
    }
    answers.push({ address: row.data, family });
  }
  return answers;
}

/**
 * Returns a `lookup(hostname)` with the shape of `dns.lookup(host, { all: true })`: A answers
 * first, then AAAA. Rejects on any transport error, HTTP error, malformed body, non-zero DNS
 * status, timeout, or when neither type yields an address.
 */
export function createDohLookup(endpoint, options = {}) {
  const base = parseDohUrl(endpoint);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DOH_TIMEOUT_MS;

  async function query(hostname, type, signal) {
    const url = new URL(base);
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", type);
    const response = await fetchImpl(url, {
      headers: { accept: "application/dns-json" },
      // A redirect target may be a hostname, which would go back through the intercepted resolver.
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error(`DoH HTTP ${response.status}`);
    return addressRows(JSON.parse(await response.text()));
  }

  return async (hostname) => {
    const controller = new AbortController();
    let timer;
    // The deadline does not rely on fetch honouring the signal; it also aborts the requests.
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error("DoH lookup timed out");
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      const [v4, v6] = await Promise.race([
        Promise.all([
          query(hostname, "A", controller.signal),
          query(hostname, "AAAA", controller.signal),
        ]),
        deadline,
      ]);
      const answers = [...v4, ...v6];
      if (answers.length === 0) throw new Error("DoH lookup returned no address");
      return answers;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
