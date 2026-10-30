// Resolves the SandboxProvider for `main()`. The Gateway depends on the provider only through the
// contracts interface; the Docker implementation is loaded by name so this package never links
// against it. Until `@deskmates/sandbox-docker` ships, runs fail with `sandbox_unavailable`.

import {
  DeskmatesError,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { GatewayConfig } from "./config.js";

/** Placeholder provider: every operation reports that no sandbox backend is available. */
export class UnavailableProvider implements SandboxProvider {
  readonly kind = "fake" as const;
  constructor(private readonly reason: string) {}
  private fail(): never {
    throw new DeskmatesError("sandbox_unavailable", this.reason);
  }
  async preflight(_spec: SandboxSpec): Promise<void> {
    this.fail();
  }
  async create(_spec: SandboxSpec): Promise<SandboxHandle> {
    return this.fail();
  }
  async attach(_workspaceId: WorkspaceId): Promise<SandboxHandle | undefined> {
    return this.fail();
  }
  async removeStaleSandbox(): Promise<never> {
    return this.fail();
  }
  async exec(): Promise<never> {
    return this.fail();
  }
  async killRun(): Promise<void> {
    this.fail();
  }
  async injectEnv(): Promise<void> {
    this.fail();
  }
  async updateEgress(): Promise<undefined> {
    return this.fail();
  }
  async snapshot(): Promise<never> {
    return this.fail();
  }
  async destroy(): Promise<void> {
    this.fail();
  }
  async permanentlyDelete(): Promise<void> {
    this.fail();
  }
}

const PROVIDER_MODULES: Record<GatewayConfig["sandboxProvider"], string> = {
  docker: "@deskmates/sandbox-docker",
  "desktop-vm": "@deskmates/sandbox-desktop-vm",
};

export async function resolveProvider(config: GatewayConfig): Promise<SandboxProvider> {
  const moduleName = PROVIDER_MODULES[config.sandboxProvider];
  try {
    // The module name is a runtime value so TypeScript does not require the package at build time.
    const mod = (await import(moduleName)) as {
      createSandboxProvider?: (c: GatewayConfig) => SandboxProvider;
    };
    if (typeof mod.createSandboxProvider === "function") return mod.createSandboxProvider(config);
    return new UnavailableProvider(`${moduleName} exports no createSandboxProvider`);
  } catch (err) {
    return new UnavailableProvider(`${moduleName} could not be loaded: ${String(err)}`);
  }
}
