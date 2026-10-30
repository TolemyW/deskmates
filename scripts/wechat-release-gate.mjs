// ADR-0047 decision 16: development is authorized; live acceptance is not implied by unit tests.
import { existsSync, readFileSync } from "node:fs";

export const WECHAT_GATE_RECORD = new URL(
  "../docs/design/wechat-native-readiness-2026-10-27.md",
  import.meta.url,
);

export function wechatReleaseReady(record) {
  return Array.from({ length: 8 }, (_, i) => `W${i + 1}`).every((gate) =>
    new RegExp(`^\\| ${gate} \\| passed \\| [^|\\n]+ \\|$`, "m").test(record),
  );
}

export function wechatPluginEntries({ development = false, required = false } = {}) {
  const ready =
    existsSync(WECHAT_GATE_RECORD) && wechatReleaseReady(readFileSync(WECHAT_GATE_RECORD, "utf8"));
  if (required && !ready && !development)
    throw new Error(
      "WeChat release gates W1–W8 are incomplete; use the separate development manifest for authorized account testing.",
    );
  return ready || development
    ? [{ id: "wechat", version: "1.0.0", apiVersion: 2, entry: "wechat/plugin.js" }]
    : [];
}
