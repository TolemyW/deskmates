import { get } from "node:https";
import type { WAVersion } from "@whiskeysockets/baileys";
import { HttpsProxyAgent } from "https-proxy-agent";

const SERVICE_WORKER_URL = "https://web.whatsapp.com/sw.js";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_SERVICE_WORKER_BYTES = 16 * 1024 * 1024;

type DownloadServiceWorker = (proxyUrl?: string) => Promise<string>;

/** Extract the current client revision advertised by WhatsApp Web. */
export function parseWaWebVersion(source: string): WAVersion | undefined {
  const match = source.match(/\\?"client_revision\\?":\s*(\d+)/);
  if (!match?.[1]) return undefined;
  const revision = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(revision) || revision <= 0) return undefined;
  return [2, 3000, revision];
}

async function downloadWaWebServiceWorker(proxyUrl?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(
      SERVICE_WORKER_URL,
      {
        ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
        headers: {
          "sec-fetch-site": "none",
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`WhatsApp Web version request returned ${response.statusCode ?? 0}`));
          return;
        }
        response.setEncoding("utf8");
        let body = "";
        let bytes = 0;
        response.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_SERVICE_WORKER_BYTES) {
            request.destroy(new Error("WhatsApp Web service worker exceeded the size limit"));
            return;
          }
          body += chunk;
        });
        response.once("error", reject);
        response.once("end", () => resolve(body));
      },
    );
    request.once("timeout", () =>
      request.destroy(new Error("WhatsApp Web version request timed out")),
    );
    request.once("error", reject);
  });
}

/**
 * Resolve the live protocol revision before pairing. Failure is deliberately non-fatal: Baileys'
 * bundled revision remains the fallback so a metadata outage cannot disable an existing channel.
 */
export async function resolveWaWebVersion(
  proxyUrl?: string,
  download: DownloadServiceWorker = downloadWaWebServiceWorker,
): Promise<WAVersion | undefined> {
  try {
    return parseWaWebVersion(await download(proxyUrl));
  } catch {
    return undefined;
  }
}
