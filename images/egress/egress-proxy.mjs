import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import { createDohLookup } from "./doh-lookup.mjs";
import { connectTarget, createPolicyState, parsePolicyDocument } from "./egress-policy.mjs";
import { hostException, hostPort, resolveHostTarget } from "./host-target.mjs";
import { expireSocket } from "./private-expiry.mjs";
import { startScreenRelays } from "./screen-relay.mjs";
import { guardSocket } from "./socket-guard.mjs";

const POLICY_FILE = "/run/deskmates-egress/allowlist";
const ACK_FILE = "/run/deskmates-egress/allowlist.sha256";
const sockets = new Set();
const publicPolicySockets = new Set();
const policy = createPolicyState();
const hostTarget = await resolveHostTarget(
  process.env.DESKMATES_HOST_TARGET,
  process.env.DESKMATES_HOST_FALLBACK_IP,
);

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function loadPolicy() {
  const text = await fs.readFile(POLICY_FILE, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const document = parsePolicyDocument(text);
  policy.replace(document.allowlist, document.privateTargets, document.grants);
  for (const socket of publicPolicySockets) socket.destroy();
  await fs.writeFile(ACK_FILE, `${digest(text)}\n`, { mode: 0o600 });
  process.stdout.write(`egress policy loaded (${policy.size} patterns)\n`);
}

// With DESKMATES_DOH_URL set, names resolve through that DNS-over-HTTPS endpoint instead of the
// container's port-53 resolvers, which some hosts intercept with fake IPs (ADR-0010 decision 4a).
// An invalid URL throws here and stops the proxy rather than resolving some other way.
const dohUrl = process.env.DESKMATES_DOH_URL?.trim();
const lookup = dohUrl
  ? createDohLookup(dohUrl)
  : (host) => dns.lookup(host, { all: true, verbatim: true });

async function resolvePublic(hostname, port = 443) {
  return policy.resolvePublic(hostname, lookup, port);
}

function track(socket) {
  guardSocket(socket);
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  return socket;
}

function trackPublic(socket) {
  track(socket);
  publicPolicySockets.add(socket);
  socket.once("close", () => publicPolicySockets.delete(socket));
  return socket;
}

function deny(res, status = 403) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "Content-Type": "text/plain", Connection: "close" });
  res.end("egress denied\n");
}

const server = http.createServer(async (request, response) => {
  try {
    const target = new URL(request.url ?? "");
    const isHost = hostException(target.hostname);
    const port = target.port === "" ? 80 : Number(target.port);
    // A network-profile grant may name HTTP on any port (ADR-0027 amendment 1 decision 10).
    const lan =
      isHost || target.protocol !== "http:"
        ? undefined
        : policy.lanTarget("http", target.hostname, port, hostTarget);
    if (target.protocol !== "http:" || (!isHost && lan === undefined && port !== 80)) {
      deny(response);
      return;
    }
    const answer = isHost
      ? { address: hostTarget, family: net.isIP(hostTarget) }
      : (lan ?? (await resolvePublic(target.hostname, 80)));
    const headers = Object.fromEntries(
      Object.entries({ ...request.headers, host: target.host }).filter(
        ([name]) => name !== "proxy-authorization" && name !== "proxy-connection",
      ),
    );
    const upstream = http.request(
      {
        ...connectTarget(answer, isHost ? hostPort(target.port, 80) : port),
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upstreamResponse) => {
        upstreamResponse.on("error", () => response.destroy());
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    request.on("error", () => upstream.destroy());
    response.on("error", () => upstream.destroy());
    if (isHost) track(upstream);
    else trackPublic(upstream);
    if (answer.expiresAt !== undefined)
      upstream.once("socket", (socket) => expireSocket(socket, answer.expiresAt));
    upstream.on("error", () => deny(response, 502));
    request.pipe(upstream);
  } catch {
    deny(response);
  }
});

server.on("connect", async (request, client, head) => {
  try {
    const separator = request.url?.lastIndexOf(":") ?? -1;
    const hostname = request.url?.slice(0, separator) ?? "";
    const port = request.url?.slice(separator + 1) ?? "";
    if (separator < 1) throw new Error("port denied");
    const isHost = hostException(hostname);
    if (!/^[0-9]{1,5}$/.test(port)) throw new Error("port denied");
    const portNumber = Number(port);
    // A tunnel is the HTTPS path: a grant must list https on this port (ADR-0027 amendment 1).
    const lan = isHost ? undefined : policy.lanTarget("https", hostname, portNumber, hostTarget);
    if (!isHost && lan === undefined && port !== "443") throw new Error("port denied");
    const answer = isHost
      ? { address: hostTarget, family: net.isIP(hostTarget) }
      : (lan ?? (await resolvePublic(hostname.replace(/^\[|\]$/g, ""))));
    const upstream = (isHost ? track : trackPublic)(
      net.connect(connectTarget(answer, isHost ? hostPort(port, 443) : portNumber)),
    );
    if (answer.expiresAt !== undefined) {
      expireSocket(upstream, answer.expiresAt);
      expireSocket(client, answer.expiresAt);
    }
    guardSocket(client, () => upstream.destroy());
    if (!isHost) trackPublic(client);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
  } catch {
    if (!client.destroyed) client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  }
});

server.on("connection", track);
process.on("SIGHUP", () => {
  // Invalidate authorizations as soon as the reload signal arrives, before the policy file read.
  // A DNS lookup already in flight observes the generation change when its await completes.
  policy.failClosed();
  for (const socket of publicPolicySockets) socket.destroy();
  loadPolicy().catch(() => {
    // Fail closed now, rather than retaining the previous policy until the provider's
    // acknowledgement timeout notices the failed reload.
    policy.failClosed();
    for (const socket of publicPolicySockets) socket.destroy();
    process.stderr.write("egress policy reload failed\n");
  });
});

// Every process start is deny-all, including an automatic container or daemon restart. The file
// is on tmpfs and may or may not survive a particular restart path, so never trust what is there.
// DockerProvider applies the current Gateway policy over stdin and waits for its acknowledgement.
await fs.writeFile(POLICY_FILE, "", { mode: 0o600 });
await loadPolicy();
server.listen(3128, "0.0.0.0", () => process.stdout.write("egress proxy ready\n"));

const closeScreens = process.env.DESKMATES_SCREEN_TARGET
  ? startScreenRelays(
      process.env.DESKMATES_SCREEN_TARGET,
      [6080, 6081, 6082, 6083, 6084, 6085, 6086],
    )
  : () => {};
// Node is PID 1 here. Install explicit handlers; otherwise Linux can leave Docker waiting
// for its full stop deadline. No persistent state needs flushing in this stateless relay.
const shutdown = () => {
  policy.failClosed();
  closeScreens();
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
