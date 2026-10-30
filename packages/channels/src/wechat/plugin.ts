import type { ChannelPluginV2 } from "@deskmates/contracts";
import { loadProviderDependency } from "../provider-dependencies.js";
import { WechatApi, type WechatTransport } from "./api.js";
import { WechatConnection } from "./connection.js";

export interface WechatPluginOptions {
  transport?: WechatTransport;
  encodeQr?: (text: string) => Promise<string>;
  retryMs?: number;
  pollPauseMs?: number;
}

export function createWechatPlugin(options: WechatPluginOptions = {}): ChannelPluginV2 {
  return {
    manifest: {
      apiVersion: 2,
      id: "wechat",
      version: "1.0.0",
      displayName: "WeChat",
      description:
        "Scan with WeChat to connect one account to one Deskmates bot. Private text conversations only.",
      multipleConnections: true,
      capabilities: {
        directMessages: "available",
        groups: "unavailable",
        inboundImages: "disabled",
        inboundOtherMedia: "disabled",
        outboundReply: "available",
        proactiveMessages: "unavailable",
        streaming: "unavailable",
        approvals: "available",
        testMessage: "unavailable",
      },
      methods: [
        {
          id: "qr",
          identity: "link",
          label: "Scan with WeChat",
          description:
            "Choose a bot, connect, then scan the QR code with WeChat and confirm on your phone.",
          fields: [],
          setup: {
            steps: [
              {
                id: "account",
                text: "Use a WeChat account eligible for iLink. Each connected account is answered by exactly one Deskmates bot.",
              },
              {
                id: "scan",
                text: "Choose the bot and connect below. Scan the QR code with WeChat and confirm authorization on your phone.",
              },
              {
                id: "message",
                text: "Send a private text message from WeChat to check the reply. Groups, images, voice and files are not supported in this version.",
              },
              {
                id: "relink",
                text: "If authorization expires, link the same account again. Disconnect here stops synchronization; remove authorization in WeChat to revoke it there.",
              },
            ],
          },
        },
      ],
      statusVocabulary: [
        "connecting",
        "qr",
        "connected",
        "reconnecting",
        "logged_out",
        "error",
        "stopped",
      ],
    },
    create: async () => {
      const live = new Map<string, WechatConnection>();
      const close = async (id: string) => {
        const connection = live.get(id);
        live.delete(id);
        await connection?.close();
      };
      return {
        verify: async () => {
          throw new Error("WeChat identity is verified after scanning the QR code.");
        },
        open: async (request, host) => {
          if (request.method !== "qr") throw new Error("Unknown WeChat connection method");
          await close(request.connectionId);
          const connection = new WechatConnection({
            request,
            host,
            api: new WechatApi(options.transport),
            encodeQr:
              options.encodeQr ??
              (async (text) => {
                const qr = await loadProviderDependency<typeof import("qrcode")>(
                  "wechat",
                  "qrcode",
                );
                return qr.toDataURL(text, { width: 320, margin: 4, errorCorrectionLevel: "M" });
              }),
            ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
            ...(options.pollPauseMs === undefined ? {} : { pollPauseMs: options.pollPauseMs }),
          });
          live.set(request.connectionId, connection);
          return connection.start();
        },
        close,
        status: async (id) => live.get(id)?.status() ?? { phase: "stopped" },
        test: async () => {
          throw new Error("Send a private text message in WeChat to test this connection.");
        },
        webhook: async () => ({ status: 404, body: "WeChat uses long polling" }),
        stop: async () => {
          await Promise.allSettled([...live.keys()].map(close));
        },
      };
    },
  };
}

export const channelPlugin: ChannelPluginV2 = createWechatPlugin();
