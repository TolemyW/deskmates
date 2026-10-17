// `app_publish` (ADR-0035 decision 1): a bot publishes a service it started in this workspace so
// signed-in members can open it in their own browser. The sidecar forwards the port and label;
// the Gateway binds workspace, bot and run, checks the port and returns the URL to post in chat.

import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { APP_SHARE_LABEL_MAX } from "@deskmates/contracts";
import { z } from "zod";
import type { ThreadToolsContext } from "./thread-tools.js";

const DESCRIPTION = [
  "Publish a web app or API you started in this workspace so the people in this workspace can open it in their own browser.",
  "Start the service first, detached so it outlives this run (for example `setsid nohup node server.js > /tmp/app.log 2>&1 &`), listening on 0.0.0.0 (not 127.0.0.1) on a port from 1024 to 65535, not 6080 to 6086.",
  "Serve the frontend and its API from one port (for example the API under /api/); the published URL is a separate origin, so use relative URLs, not localhost.",
  "The tool returns the app's URL: post it in the chat. Publishing the same port again updates its label. Only signed-in members of this workspace can open it; a person can stop sharing it.",
].join(" ");

// biome-ignore lint/suspicious/noExplicitAny: the SDK erases schema generics in its tool registry
export function appShareTools(ctx: ThreadToolsContext): SdkMcpToolDefinition<any>[] {
  if (!ctx.request.tools.includes("app_publish")) return [];
  return [
    ctx.tool(
      "app_publish",
      DESCRIPTION,
      {
        port: z.number().int().min(1024).max(65535),
        label: z.string().min(1).max(APP_SHARE_LABEL_MAX),
      },
      async (args) => {
        try {
          const { share, existing } = await ctx.client.publishApp({
            port: args.port,
            label: args.label,
          });
          ctx.sink.emit("log", {
            source: "app_publish",
            shareId: share.id,
            port: share.port,
            existing,
            state: share.state,
          });
          const status =
            share.state === "available"
              ? "The service answers on that port now."
              : `Nothing answers on port ${share.port} yet (${share.reason ?? "unavailable"}): start the service detached, listening on 0.0.0.0:${share.port}, and check with \`ss -ltn\` that it listens on 0.0.0.0:${share.port} before posting the link.`;
          const text = `${existing ? "Updated" : "Published"} "${share.label}" (port ${share.port}): ${share.url}\n${status}`;
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          ctx.sink.emit("log", {
            source: "app_publish",
            port: args.port,
            level: "warn",
            error: String(err),
          });
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `The app was not published: ${message}` }],
            isError: true,
          };
        }
      },
    ),
  ];
}
