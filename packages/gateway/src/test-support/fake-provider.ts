// Minimal in-process SandboxProvider for gateway T1 tests. `exec` hands the StartRunRequest to a
// scriptable handler that plays the sidecar: it talks back to the Gateway over HTTP using the
// run's short-lived token, exactly as the real sidecar would.
//
// The gateway keeps its own fake on purpose. @deskmates/testkit's fake provider is a behavioural
// model of a sandbox (env layering, fault injection, snapshots); what these tests need is an
// HTTP script that plays a sidecar against a live Gateway, so the double stays here, next to the
// harness that drives it, and stays small.

import { createHash } from "node:crypto";
import {
  DeskmatesError,
  type EgressAcknowledgement,
  type EgressProbeRequest,
  type EgressProbeResult,
  type ExecRequest,
  type ExecResult,
  type NetworkGrant,
  type SandboxHandle,
  type SandboxImageDrift,
  type SandboxProvider,
  type SandboxSnapshot,
  type SandboxSpec,
  type SandboxVolatilePrerequisite,
  type StartRunRequest,
  type WorkspaceId,
} from "@deskmates/contracts";

/** Plays the sidecar. May resolve to a partial ExecResult (exit code, stderr) or to nothing. */
export type SidecarScript = (
  request: StartRunRequest,
  gateway: FakeSidecarClient,
) => Promise<unknown>;

/** Convenience HTTP client bound to one run's internal routes. */
export class FakeSidecarClient {
  constructor(
    private readonly baseUrl: string,
    private readonly runId: string,
    private readonly token: string,
  ) {}

  async post(path: string, body: unknown, token: string = this.token): Promise<Response> {
    return fetch(`${this.baseUrl}/internal/runs/${this.runId}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  async get(path: string, token: string = this.token): Promise<Response> {
    return fetch(`${this.baseUrl}/internal/runs/${this.runId}/${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async model(path: string, body: unknown, token: string = this.token): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }
}

export interface ExecCall {
  handle: SandboxHandle;
  req: ExecRequest;
  request: StartRunRequest;
}

export class FakeProvider implements SandboxProvider {
  readonly created: SandboxSpec[] = [];
  readonly destroyed: SandboxHandle[] = [];
  readonly permanentlyDeleted: { workspaceId: WorkspaceId; tenantId?: string }[] = [];
  /** `create` and `destroy` in the order they happened; the restart route asserts on it. */
  readonly ops: ("create" | "destroy")[] = [];
  readonly injected: Record<string, string>[] = [];
  readonly execCalls: ExecCall[] = [];
  /**
   * Errors `exec` throws instead of running the script, one per call, oldest first. Rehearses a
   * sandbox that went away between calls (the provider raises `not_found`).
   */
  readonly execErrors: Error[] = [];
  /** Thrown by the next `create` calls in order, e.g. a container that never became healthy. */
  readonly createErrors: Error[] = [];
  /**
   * Host address the created handle reports for noVNC, as the Docker provider does for a
   * published port. Undefined means the sandbox publishes nothing, so there is no takeover URL.
   */
  novncAddress: string | undefined;
  /** Memory-only credential returned with the noVNC address when configured by a test. */
  novncPassword: string | undefined;
  private script: SidecarScript = async () => undefined;

  /** `kind` is what the Gateway keys provider-specific decisions on; tests may pose as Docker. */
  constructor(readonly kind: SandboxProvider["kind"] = "fake") {}

  /** Set what "the sidecar" does when the Gateway execs it. */
  onRun(script: SidecarScript): void {
    this.script = script;
  }

  volatilePrerequisites: readonly SandboxVolatilePrerequisite[] = [];
  async inspectVolatilePrerequisites(
    _spec: SandboxSpec,
    _requiredProviderRef?: string,
  ): Promise<readonly SandboxVolatilePrerequisite[]> {
    return this.volatilePrerequisites;
  }

  async preflight(_spec: SandboxSpec): Promise<void> {}

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.created.push(spec);
    const failure = this.createErrors.shift();
    if (failure) throw failure;
    this.ops.push("create");
    return {
      workspaceId: spec.workspaceId,
      providerRef: `fake-${spec.workspaceId}`,
      sidecarAddress: "fake://sidecar",
      ...(this.novncAddress === undefined ? {} : { novncAddress: this.novncAddress }),
      ...(this.novncPassword === undefined ? {} : { novncPassword: this.novncPassword }),
    };
  }

  readonly egressUpdates: {
    handle: SandboxHandle;
    allowlist: readonly string[];
    grants: readonly NetworkGrant[];
    reloaded: boolean;
  }[] = [];
  /** The policy each workspace's fake proxy acknowledges, by hash, as the Docker proxy does. */
  readonly acknowledgedPolicy = new Map<string, string>();
  /** Workspaces whose next `updateEgress` fails, as an unacknowledged reload does. */
  readonly egressFailures = new Set<string>();
  async updateEgress(
    handle: SandboxHandle,
    allowlist: readonly string[],
    grants: readonly NetworkGrant[] = [],
  ): Promise<EgressAcknowledgement> {
    if (this.egressFailures.delete(handle.workspaceId)) {
      this.acknowledgedPolicy.delete(handle.workspaceId);
      throw new DeskmatesError("sandbox_unavailable", "egress policy reload was not acknowledged", {
        reason: "egress_reload_failed",
      });
    }
    const policyHash = createHash("sha256")
      .update(JSON.stringify({ allowlist: [...allowlist].sort(), grants }))
      .digest("hex");
    const reloaded = this.acknowledgedPolicy.get(handle.workspaceId) !== policyHash;
    this.acknowledgedPolicy.set(handle.workspaceId, policyHash);
    this.egressUpdates.push({ handle, allowlist: [...allowlist], grants: [...grants], reloaded });
    return { policyHash, reloaded };
  }

  /** Every connectivity probe asked for, and what the fake proxy answers (ADR-0027 amd. 1). */
  readonly probes: EgressProbeRequest[] = [];
  probeAnswer: EgressProbeResult = {
    ok: true,
    layers: [
      { layer: "tcp", ok: true },
      { layer: "http", ok: true },
    ],
    status: 200,
  };
  async probeEgress(_handle: SandboxHandle, request: EgressProbeRequest) {
    this.probes.push(request);
    return this.probeAnswer;
  }

  /** Sandboxes `attach` finds, as if an earlier Gateway process had left them running. */
  readonly existing = new Map<string, SandboxHandle>();
  /**
   * What `removeStaleSandbox` reports per workspace. A non-empty drift removes the workspace's
   * `existing` sandbox, as the Docker provider removes the stale containers.
   */
  readonly drift = new Map<string, readonly SandboxImageDrift[]>();
  /** Thrown by every `removeStaleSandbox` while set, e.g. an `image_missing` error. */
  staleCheckError: Error | undefined;
  readonly staleChecks: { workspaceId: WorkspaceId; image: string }[] = [];

  async attach(workspaceId: WorkspaceId): Promise<SandboxHandle | undefined> {
    return this.existing.get(workspaceId);
  }

  async removeStaleSandbox(
    workspaceId: WorkspaceId,
    image: string,
    beforeRemove?: (drift: readonly SandboxImageDrift[]) => Promise<void>,
  ): Promise<readonly SandboxImageDrift[]> {
    this.staleChecks.push({ workspaceId, image });
    if (this.staleCheckError) throw this.staleCheckError;
    if (!this.existing.has(workspaceId)) return [];
    const drift = this.drift.get(workspaceId) ?? [];
    if (drift.length === 0) return [];
    await beforeRemove?.(drift);
    this.existing.delete(workspaceId);
    return drift;
  }

  async exec(handle: SandboxHandle, req: ExecRequest): Promise<ExecResult> {
    const failure = this.execErrors.shift();
    if (failure) throw failure;
    const request = JSON.parse(req.stdin ?? "{}") as StartRunRequest;
    this.execCalls.push({ handle, req, request });
    const client = new FakeSidecarClient(
      request.gatewayBaseUrl,
      request.runId,
      request.modelAuthToken,
    );
    // Like DockerProvider: no deadline unless the caller sets one; past it the result reports
    // timedOut with exit -1 (the real provider also kills the process tree).
    const timeout =
      req.timeoutMs === undefined
        ? new Promise<never>(() => {})
        : new Promise<ExecResult>((resolve) =>
            setTimeout(
              () => resolve({ exitCode: -1, stdout: "", stderr: "", timedOut: true }),
              req.timeoutMs,
            ).unref(),
          );
    // An abort ends the exec like the deadline does; the script itself is left to finish.
    const aborted = new Promise<ExecResult>((resolve) => {
      const killed = () => resolve({ exitCode: -1, stdout: "", stderr: "", timedOut: true });
      if (req.signal?.aborted) killed();
      else req.signal?.addEventListener("abort", killed, { once: true });
    });
    const scripted = (async (): Promise<ExecResult> => {
      try {
        const result = await this.script(request, client);
        const patch =
          typeof result === "object" && result !== null ? (result as Partial<ExecResult>) : {};
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...patch };
      } catch (err) {
        return { exitCode: 1, stdout: "", stderr: String(err), timedOut: false };
      }
    })();
    return Promise.race([scripted, timeout, aborted]);
  }

  /**
   * Every `killRun`, in order, with how many exec calls had been made by then: the restart test
   * asserts the kill of each live run came before any resume (ADR-0029 decision 4).
   */
  readonly killedRuns: { workspaceId: WorkspaceId; runId: string; execCallsBefore: number }[] = [];
  async killRun(handle: SandboxHandle, runId: string): Promise<void> {
    this.killedRuns.push({
      workspaceId: handle.workspaceId,
      runId,
      execCallsBefore: this.execCalls.length,
    });
  }

  async injectEnv(_handle: SandboxHandle, env: Readonly<Record<string, string>>): Promise<void> {
    this.injected.push({ ...env });
  }

  async snapshot(_handle: SandboxHandle): Promise<SandboxSnapshot> {
    return { takenAt: new Date().toISOString(), ref: "fake-snapshot" };
  }

  /** Like the Docker provider: the container goes, its named volumes stay. */
  async destroy(handle: SandboxHandle): Promise<void> {
    this.destroyed.push(handle);
    this.ops.push("destroy");
  }

  async permanentlyDelete(workspaceId: WorkspaceId, tenantId?: string): Promise<void> {
    this.permanentlyDeleted.push({ workspaceId, ...(tenantId ? { tenantId } : {}) });
    this.existing.delete(workspaceId);
  }
}
