// A separate golden-site container, plus a host-only mutation proxy. The same generated test
// must pass the actual app and reject a dashboard count regression; reply markers cannot pass.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { gatewayUrlForContainer } from "@deskmates/sandbox-docker";
import { requireImageId } from "./image-id.mjs";
import { journalM3Fixture } from "./m3-fixture-journal.js";

export async function startProductFixture(): Promise<{
  origin: string;
  mutantOrigin: string;
  hostOrigin: string;
  mutantHostOrigin: string;
  mutationHits(): number;
  close(): Promise<void>;
}> {
  const image = requireImageId(process.env.GOLDEN_SITE_IMAGE, "GOLDEN_SITE_IMAGE");
  const docker = (...args: string[]) =>
    execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
  const name = `m3-product-${randomUUID()}`;
  journalM3Fixture("container", name);
  const id = docker(
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "deskmates.test=m3-product",
    "-p",
    "0.0.0.0::4477",
    image,
  );
  let mutationHits = 0;
  const proxy = createServer((incoming, outgoing) => {
    const upstream = request(
      {
        hostname: "127.0.0.1",
        port,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", () => outgoing.destroy());
        response.on("end", () => {
          let body = Buffer.concat(chunks);
          if (incoming.url?.split("?")[0] === "/dashboard" && response.statusCode === 200) {
            const original = body.toString("utf8");
            const mutated = original.replace(
              /(id="open-ticket-count">)\d+/,
              (_, prefix: string) => `${prefix}9999`,
            );
            if (original !== mutated) mutationHits++;
            body = Buffer.from(mutated);
          }
          const headers = Object.fromEntries(
            Object.entries(response.headers).filter(([key]) => key !== "transfer-encoding"),
          );
          headers["content-length"] = String(body.length);
          outgoing.writeHead(response.statusCode ?? 502, headers);
          outgoing.end(body);
        });
      },
    );
    upstream.on("error", () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  let port = 0;
  const close = async () => {
    proxy.closeAllConnections();
    if (proxy.listening)
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    docker("rm", "-f", "-v", id);
  };
  try {
    const mapping = docker("port", id, "4477/tcp");
    port = Number(mapping.split(":").at(-1));
    if (!port) throw Error("no product fixture port");
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/login`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) break;
      } catch {
        /* Wait only for this owned app to become ready. */
      }
      if (Date.now() >= deadline) throw Error("product fixture not ready");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "0.0.0.0", resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === "string") throw Error("no mutation proxy port");
    return {
      origin: gatewayUrlForContainer(`http://127.0.0.1:${port}`),
      mutantOrigin: gatewayUrlForContainer(`http://127.0.0.1:${address.port}`),
      hostOrigin: `http://127.0.0.1:${port}`,
      mutantHostOrigin: `http://127.0.0.1:${address.port}`,
      mutationHits: () => mutationHits,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
