// One `model_switch` event per model switch the SDK makes (ADR-0023 decision 3). SDK 0.3.278 has
// two signals for a switch: the `PostModelSwitch` hook (resume, `/model`, SDK `set_model`), and,
// for an overload fallback to `fallbackModel`, a `system` message with subtype `model_fallback`
// that comes without the hook (found by `acceptance/m4-model-selection.container.test.ts`). The
// recorder takes both, and records a switch reported by both within one model turn once.

import type { ModelSwitchPayload } from "@deskmates/contracts";

/**
 * The overload-fallback message as SDK 0.3.278 sends it. The SDK does not type it: it is not in
 * the `SDKMessage` union, so the sidecar reads it through this narrow shape and nothing else.
 */
export interface SdkModelFallbackMessage {
  type: "system";
  subtype: "model_fallback";
  original_model: string;
  fallback_model: string;
  trigger?: string;
}

export function isModelFallbackMessage(msg: unknown): msg is SdkModelFallbackMessage {
  if (msg === null || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    m.type === "system" &&
    m.subtype === "model_fallback" &&
    typeof m.original_model === "string" &&
    m.original_model !== "" &&
    typeof m.fallback_model === "string" &&
    m.fallback_model !== ""
  );
}

/** The switch an overload fallback is: the SDK chose it by itself, so `auto`. */
export function fallbackSwitch(msg: SdkModelFallbackMessage): ModelSwitchPayload {
  return { from: msg.original_model, to: msg.fallback_model, source: "auto" };
}

export class ModelSwitchRecorder {
  /** The assistant message id the current turn's switches were seen after. */
  private turn: string | undefined;
  private readonly seen = new Set<string>();

  constructor(private readonly emit: (payload: ModelSwitchPayload) => void) {}

  /** A model response: switches after it belong to a new turn. */
  observeAssistant(messageId: string): void {
    if (messageId === this.turn) return;
    this.turn = messageId;
    this.seen.clear();
  }

  /** Emits the switch unless the same `from` and `to` were already recorded in this turn. */
  record(payload: ModelSwitchPayload): void {
    const key = JSON.stringify([payload.from, payload.to]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.emit(payload);
  }
}
