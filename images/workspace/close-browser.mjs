// Runs only during workspace shutdown. No SDK, model, packages or outward network.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function closeBrowser({
  fetcher = fetch,
  WebSocketImpl = WebSocket,
  timeoutMs = 4000,
} = {}) {
  return new Promise((resolveClose, rejectClose) => {
    const controller = new AbortController();
    let socket;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.abort();
      try {
        socket?.close();
      } catch {
        // A connecting socket can reject close; the CLI exits after settling.
      }
      if (error) rejectClose(error);
      else resolveClose();
    };
    const timer = setTimeout(() => finish(new Error("browser close timed out")), timeoutMs);
    void (async () => {
      const response = await fetcher("http://127.0.0.1:9222/json/version", {
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error("browser endpoint unavailable");
      const version = await response.json();
      if (settled) return;
      const endpoint = new URL(version.webSocketDebuggerUrl);
      if (
        endpoint.protocol !== "ws:" ||
        endpoint.hostname !== "127.0.0.1" ||
        endpoint.port !== "9222" ||
        !endpoint.pathname.startsWith("/devtools/browser/") ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      ) {
        throw new Error("browser endpoint is not the local browser");
      }
      socket = new WebSocketImpl(endpoint.href);
      socket.addEventListener("open", () => {
        if (settled) return;
        try {
          socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
        } catch {
          finish(new Error("browser close send failed"));
        }
      });
      socket.addEventListener("message", (event) => {
        try {
          const reply = JSON.parse(event.data);
          if (reply?.id !== 1) return;
          if (reply.error || !reply.result || typeof reply.result !== "object") {
            finish(new Error("browser close was not acknowledged"));
          } else finish();
        } catch {
          finish(new Error("invalid browser close response"));
        }
      });
      socket.addEventListener("error", () => finish(new Error("browser close connection failed")));
      socket.addEventListener("close", () =>
        finish(new Error("browser closed before acknowledgement")),
      );
    })().catch(() => finish(new Error("browser endpoint query failed")));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await closeBrowser();
    console.log("chromium graceful shutdown acknowledged");
    process.exit(0);
  } catch {
    console.error("chromium graceful shutdown unavailable; falling back to signals");
    process.exit(1);
  }
}
