// What Deskmates knows about a configured model's ability to see images (ADR-0023 amendment 1,
// issue #87). A capability is observed by a short synthetic probe job, never assumed from a
// model's name, and an uncertain observation stays `unknown`.

/** `pending` while a probe runs; the three others are results. */
export type CapabilityStatus = "pending" | "supported" | "unsupported" | "unknown";

/**
 * Why a result is what it is. `verified_answer` is the only reason for `supported` and
 * `explicit_refusal` the only one for `unsupported`; every other reason is `unknown`.
 */
export type VisionProbeReason =
  | "verified_answer"
  | "explicit_refusal"
  | "wrong_answer"
  | "no_transport_evidence"
  | "job_failed"
  | "blocked"
  | "not_probed";

/** What queued a probe (ADR-0023 amendment 1, decision 6). A read never does. */
export type VisionProbeTrigger = "model_added" | "model_changed" | "startup" | "retry";

/**
 * Probe protocol plus the pinned Agent SDK that carries the image: part of the cache key, so a
 * change to either starts every model at `unknown` again.
 */
export const VISION_PROBE_ADAPTER_REVISION = "vision-probe-1/agent-sdk-0.3.278";

/** Retries per cache key in any 24 hours (decision 8). */
export const VISION_PROBE_ATTEMPTS_PER_DAY = 3;

/** One probe and its receipt, or the absence of one (`id: null`, reason `not_probed`). */
export interface VisionProbeView {
  id: string | null;
  model: string;
  status: CapabilityStatus;
  reason: VisionProbeReason | null;
  trigger?: VisionProbeTrigger;
  runId?: string | null;
  /** The model's answer, truncated; the receipt for a wrong or refused answer. */
  answer?: string | null;
  /** Image blocks the model proxy forwarded for the probe run; null when it saw none recorded. */
  imageBlocks?: number | null;
  inputTokens?: number | null;
  error?: string | null;
  createdAt?: string;
  finishedAt?: string | null;
}

/** `GET /api/workspaces/:id/model-capabilities`: the current result per model in use. */
export interface ModelCapabilityView {
  model: string;
  vision: VisionProbeView;
  /** What a run on this model started now would do with images (amendment 2, decision 11). */
  visionPolicy?: VisionPolicy;
  /** Active bots whose effective model this is (decision 14); the deployment default may have none. */
  botIds?: string[];
}

/** The capability a run records at start for its frozen model (decision 9). */
export interface RunModelCapabilities {
  vision: { status: CapabilityStatus; reason: VisionProbeReason | null; probeId: string | null };
}

/**
 * What a run does with images (ADR-0023 amendment 2, decision 11): `deliver` gives the model
 * image blocks as before; `withhold` replaces them with a text notice so a model that cannot see
 * cannot pretend to.
 */
export type VisionPolicy = "deliver" | "withhold";

/**
 * The policy for a recorded capability. `unsupported` withholds; so does an `unknown` whose probe
 * got a wrong answer (observed confabulation; proposed). Every other state delivers unchanged:
 * the probe is off by default, and withholding on `not_probed` would blind models that can see.
 * The status is never rewritten by the policy.
 */
export function visionPolicyFor(vision: {
  status: CapabilityStatus;
  reason: VisionProbeReason | null;
}): VisionPolicy {
  if (vision.status === "unsupported") return "withhold";
  if (vision.status === "unknown" && vision.reason === "wrong_answer") return "withhold";
  return "deliver";
}
