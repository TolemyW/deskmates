// A SandboxProvider that delegates every call to the real DockerProvider and keeps a copy of what
// crossed the boundary: exec requests (so a test can read the StartRunRequest the Gateway piped
// to `deskmates-sidecar run`) and the env maps `injectEnv` delivered. Read-only observation; nothing
// about the container changes.

import type {
  ExecRequest,
  ExecResult,
  NetworkGrant,
  SandboxHandle,
  SandboxImageDrift,
  SandboxProvider,
  SandboxSnapshot,
  SandboxSpec,
  SandboxVolatilePrerequisite,
  StartRunRequest,
  WorkspaceId,
} from "@deskmates/contracts";
import { SIDECAR_RUN_CMD } from "@deskmates/gateway";

export interface RecordedExec {
  handle: SandboxHandle;
  request: ExecRequest;
  result?: ExecResult;
  error?: string;
}

export class RecordingProvider implements SandboxProvider {
  readonly kind: SandboxProvider["kind"];
  readonly execs: RecordedExec[] = [];
  readonly injected: Record<string, string>[] = [];
  readonly specs: SandboxSpec[] = [];

  constructor(private readonly inner: SandboxProvider) {
    this.kind = inner.kind;
  }

  preflight(spec: SandboxSpec): Promise<void> {
    return this.inner.preflight(spec);
  }

  inspectVolatilePrerequisites(
    spec: SandboxSpec,
    requiredProviderRef?: string,
  ): Promise<readonly SandboxVolatilePrerequisite[]> {
    return (
      this.inner.inspectVolatilePrerequisites?.(spec, requiredProviderRef) ?? Promise.resolve([])
    );
  }

  create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.specs.push(spec);
    return this.inner.create(spec);
  }

  attach(workspaceId: WorkspaceId): Promise<SandboxHandle | undefined> {
    return this.inner.attach(workspaceId);
  }

  removeStaleSandbox(
    workspaceId: WorkspaceId,
    image: string,
  ): Promise<readonly SandboxImageDrift[]> {
    return this.inner.removeStaleSandbox(workspaceId, image);
  }

  async exec(handle: SandboxHandle, req: ExecRequest): Promise<ExecResult> {
    const entry: RecordedExec = { handle, request: req };
    this.execs.push(entry);
    try {
      entry.result = await this.inner.exec(handle, req);
      return entry.result;
    } catch (err) {
      entry.error = String(err);
      throw err;
    }
  }

  injectEnv(handle: SandboxHandle, env: Readonly<Record<string, string>>): Promise<void> {
    this.injected.push({ ...env });
    return this.inner.injectEnv(handle, env);
  }

  updateEgress(
    handle: SandboxHandle,
    allowlist: readonly string[],
    grants?: readonly NetworkGrant[],
  ): ReturnType<SandboxProvider["updateEgress"]> {
    return this.inner.updateEgress(handle, allowlist, grants);
  }

  snapshot(handle: SandboxHandle): Promise<SandboxSnapshot> {
    return this.inner.snapshot(handle);
  }

  destroy(handle: SandboxHandle): Promise<void> {
    return this.inner.destroy(handle);
  }

  permanentlyDelete(workspaceId: WorkspaceId, tenantId?: string): Promise<void> {
    return this.inner.permanentlyDelete(workspaceId, tenantId);
  }

  /** Every `deskmates-sidecar run` the Gateway started, with the request it piped on stdin. */
  sidecarRuns(): { exec: RecordedExec; request: StartRunRequest }[] {
    const out: { exec: RecordedExec; request: StartRunRequest }[] = [];
    for (const exec of this.execs) {
      const cmd = exec.request.cmd;
      if (cmd.length !== SIDECAR_RUN_CMD.length || !cmd.every((c, i) => c === SIDECAR_RUN_CMD[i]))
        continue;
      if (exec.request.stdin === undefined) continue;
      out.push({ exec, request: JSON.parse(exec.request.stdin) as StartRunRequest });
    }
    return out;
  }
}
