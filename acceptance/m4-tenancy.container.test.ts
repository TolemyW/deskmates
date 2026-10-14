// T2: ADR-0022 tenant isolation against a real Docker daemon and the real workspace image, no
// model. Two tenants each get a real workspace container. The cases check what only real Docker
// and the real image can show:
// - DOCKER-01: every container and network carries its tenant label, and attach refuses a
//   container labelled for another tenant.
// - FILE-01: a file is read only in its own tenant's container.
// - DESK: a desktop ticket over the real noVNC bridge is tenant-bound, origin-bound and
//   single-use, and closes when its person leaves the tenant.
// - E2E-01: after a restart in multi mode each tenant reattaches its own container, sessions and
//   isolation hold, and revocation ends access.
// T1 covers the same rules route by route with a fake provider (`tenant-execution.test.ts`).

import type { BotDefinition, SandboxHandle, Workspace } from "@deskmates/contracts";
import { CSRF_HEADER } from "@deskmates/contracts";
import { buildGateway } from "@deskmates/gateway";
import { networkName } from "@deskmates/sandbox-docker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const SESSION = "__Host-deskmates-session";
const PASSWORD = "m4 tenancy t2 fixture password";
const DEFAULT_TENANT = "tnt_default";
const TENANT_LABEL = "deskmates.tenant";
const SECRET_PATH = "/work/m4-tenancy/secret.txt";

interface Person {
  token: string;
  csrf: string;
}

interface Tenant {
  tenantId: string;
  owner: Person;
  workspace: Workspace;
  bot: BotDefinition;
  handle: SandboxHandle;
}

const available = await dockerAvailable();
describe.skipIf(!available)("M4 tenant isolation (real Docker, no model)", () => {
  let stack: Stack;
  /** The Gateway as the host sees it; changes when the restart case rebuilds it. */
  let base = "";
  let A: Tenant;
  let B: Tenant;

  const ctx = () => stack.app.deskmates.ctx;

  async function signIn(loginName: string): Promise<Person> {
    const { token } = await ctx().auth.login(loginName, PASSWORD, "m4-tenancy-t2");
    const session = await fetch(`${base}/auth/session`, {
      headers: { cookie: `${SESSION}=${token}` },
    });
    const { csrfToken } = (await session.json()) as { csrfToken: string };
    return { token, csrf: csrfToken };
  }

  async function addPerson(
    loginName: string,
    tenantId: string,
    role: "owner" | "member",
  ): Promise<Person> {
    await ctx().auth.createUser({
      loginName,
      displayName: loginName,
      password: PASSWORD,
      role,
      tenantId,
    });
    return signIn(loginName);
  }

  function as(person: Person | "operator", method: string, path: string, body?: unknown) {
    const headers: Record<string, string> =
      person === "operator"
        ? { authorization: `Bearer ${stack.config.operatorToken}` }
        : { cookie: `${SESSION}=${person.token}`, origin: base, [CSRF_HEADER]: person.csrf };
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function healthy(handle: SandboxHandle): Promise<void> {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const r = await stack.provider.exec(handle, {
        cmd: ["deskmates-healthz"],
        timeoutMs: 10_000,
      });
      if (r.exitCode === 0) return;
      if (Date.now() > deadline) throw new Error(`workspace never healthy: ${r.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async function writeSecret(handle: SandboxHandle, text: string): Promise<void> {
    const r = await stack.docker.exec(handle, {
      cmd: ["sh", "-c", `mkdir -p "$(dirname "$0")" && cat > "$0"`, SECRET_PATH],
      stdin: text,
      timeoutMs: 15_000,
    });
    if (r.exitCode !== 0) throw new Error(`write failed: ${r.stderr}`);
  }

  function readFile(person: Person | "operator", workspaceId: string): Promise<Response> {
    return as(
      person,
      "GET",
      `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(SECRET_PATH)}`,
    );
  }

  /** Open the desktop stream with a ticket; resolves with the first frame or the refusal. */
  function openDesktop(
    ticket: { path: string; protocol: string },
    origin: string,
  ): Promise<{ socket: WebSocket; outcome: string }> {
    const socket = new WebSocket(
      `${base.replace("http:", "ws:")}${ticket.path}`,
      [ticket.protocol],
      {
        origin,
      },
    );
    return new Promise((resolve) => {
      socket.once("message", (data) => resolve({ socket, outcome: `frame:${String(data)}` }));
      socket.once("error", (error) => resolve({ socket, outcome: String(error) }));
    });
  }

  async function desktopTicket(person: Person, botId: string) {
    const response = await as(person, "POST", `/api/bots/${botId}/screen/access`, { mode: "view" });
    return {
      status: response.status,
      json: (await response.json()) as { path: string; protocol: string; accessId: string },
    };
  }

  beforeAll(async () => {
    requireWorkspaceImageId();
    stack = await startStack({
      modelBaseUrl: "http://127.0.0.1:1",
      modelAuthToken: "unused-t2-token",
      defaultModel: "unused-model",
      cheapModel: "unused-cheap-model",
      label: "m4-tenancy",
    });
    base = stack.gatewayUrl;
    A = {
      tenantId: DEFAULT_TENANT,
      owner: await addPerson("m4-owner-a", DEFAULT_TENANT, "owner"),
      workspace: stack.workspace,
      bot: stack.bot,
      handle: stack.handle,
    };
    // Tenant B's first workspace is provisioned for its Owner: since ADR-0031 Q1 and ADR-0022
    // amendment 6 only an Owner/Admin of some workspace (or root) may create one, which a new
    // tenant's person is not. Everything after that goes through the operator API with a session.
    const tenantB = ctx().auth.users.createTenant({ name: "M4 T2 tenant B" }).id;
    const ownerB = await addPerson("m4-owner-b", tenantB, "owner");
    const ownerBId = ctx().auth.users.findLocalLogin("m4-owner-b")?.userId as string;
    const workspace: Workspace = ctx().workspaces.create({
      tenantId: tenantB,
      name: "m4-tenancy-b",
      sandboxProvider: "docker",
      egressAllowlist: [],
      ownerUserId: ownerBId,
    });
    expect(
      ctx().db.prepare("SELECT tenant_id FROM workspaces WHERE id = ?").get(workspace.id),
    ).toEqual({ tenant_id: tenantB });
    const botResponse = await as(ownerB, "POST", "/api/bots", {
      name: "m4botb",
      role: "tenant B assistant",
      workspaceId: workspace.id,
    });
    expect(botResponse.status).toBe(201);
    const { bot, welcomeRun } = (await botResponse.json()) as {
      bot: BotDefinition;
      welcomeRun: { id: string };
    };
    stack.app.deskmates.scheduler.cancel(
      welcomeRun.id as import("@deskmates/contracts").RunId,
      "test",
    );
    await stack.app.deskmates.scheduler.drain();
    const handle = await ctx().sandboxes.ensure(workspace);
    stack.extraWorkspaces.push({
      workspace,
      handle,
      volumes: stack.provider.specs.flatMap((s) =>
        s.workspaceId === workspace.id ? Object.values(s.volumes) : [],
      ),
    });
    await healthy(handle);
    B = { tenantId: tenantB, owner: ownerB, workspace, bot, handle };
    await writeSecret(A.handle, "m4-secret-of-tenant-a");
    await writeSecret(B.handle, "m4-secret-of-tenant-b");
  }, 300_000);
  afterAll(async () => stopStack(stack), 180_000);

  it("DOCKER-01: labels each tenant's containers and network, and refuses a cross-tenant attach", async () => {
    for (const tenant of [A, B]) {
      const filters = encodeURIComponent(
        JSON.stringify({ label: [`deskmates.workspace=${tenant.workspace.id}`] }),
      );
      const listed = await stack.docker.client.request(
        "GET",
        `/containers/json?all=1&filters=${filters}`,
      );
      const containers = JSON.parse(listed.body) as Array<{ Labels: Record<string, string> }>;
      // The workspace container and its egress proxy.
      expect(containers.length).toBeGreaterThanOrEqual(2);
      for (const container of containers)
        expect(container.Labels[TENANT_LABEL], tenant.workspace.id).toBe(tenant.tenantId);
      const network = await stack.docker.client.request(
        "GET",
        `/networks/${networkName(tenant.workspace.id)}`,
      );
      expect(
        (JSON.parse(network.body) as { Labels: Record<string, string> }).Labels[TENANT_LABEL],
      ).toBe(tenant.tenantId);
    }
    await expect(stack.docker.attach(B.workspace.id, A.tenantId)).rejects.toThrow(/another tenant/);
    await expect(stack.docker.attach(A.workspace.id, B.tenantId)).rejects.toThrow(/another tenant/);
    const own = await stack.docker.attach(B.workspace.id, B.tenantId);
    expect(own?.providerRef).toBe(B.handle.providerRef);
  }, 60_000);

  it("FILE-01: reads a file only through its own tenant, from its own container", async () => {
    const crossed = await readFile(B.owner, A.workspace.id);
    expect(crossed.status).toBe(404);
    expect(await crossed.text()).not.toContain("m4-secret-of-tenant-a");
    // The operator credential acts in the Default Tenant only.
    const operatorIntoB = await readFile("operator", B.workspace.id);
    expect(operatorIntoB.status).toBe(404);
    expect(await operatorIntoB.text()).not.toContain("m4-secret-of-tenant-b");
    // Each tenant reads its own file, and gets its own container's bytes.
    const ownB = await readFile(B.owner, B.workspace.id);
    expect(ownB.status).toBe(200);
    expect(await ownB.text()).toBe("m4-secret-of-tenant-b");
    const ownA = await readFile(A.owner, A.workspace.id);
    expect(ownA.status).toBe(200);
    expect(await ownA.text()).toBe("m4-secret-of-tenant-a");
  }, 60_000);

  it("DESK: a desktop ticket over the real noVNC bridge is tenant-, origin- and use-bound", async () => {
    // B can neither start nor open A's desktop.
    expect((await as(B.owner, "POST", `/api/bots/${A.bot.id}/screen/start`)).status).toBe(404);
    expect((await desktopTicket(B.owner, A.bot.id)).status).toBe(404);
    const started = await as(B.owner, "POST", `/api/bots/${B.bot.id}/screen/start`);
    expect(started.status).toBe(200);
    // A hostile Origin is refused, and the refused ticket is spent.
    const hostile = await desktopTicket(B.owner, B.bot.id);
    expect(hostile.status).toBe(200);
    const refused = await openDesktop(hostile.json, "http://attacker.example");
    expect(refused.outcome).toContain("401");
    expect((await openDesktop(hostile.json, base)).outcome).toContain("401");
    // A member's ticket from its own origin reaches the real VNC server once.
    const member = await addPerson("m4-member-b", B.tenantId, "member");
    const ticket = await desktopTicket(member, B.bot.id);
    expect(ticket.status).toBe(200);
    const opened = await openDesktop(ticket.json, base);
    expect(opened.outcome).toMatch(/^frame:RFB 00\d\.00\d/);
    expect((await openDesktop(ticket.json, base)).outcome).toContain("401");
    // Leaving the tenant closes the live desktop at the next sweep.
    const closed = new Promise<void>((resolve) => opened.socket.once("close", () => resolve()));
    const memberId = ctx().auth.users.findLocalLogin("m4-member-b")?.userId as string;
    ctx().auth.users.updateMembership(B.tenantId, memberId, { status: "removed" });
    ctx().auth.live.sweep();
    await closed;
  }, 120_000);

  it("E2E-01: after a restart in multi mode each tenant reattaches its own container", async () => {
    const specsBefore = stack.provider.specs.length;
    await stack.app.deskmates.scheduler.drain();
    await stack.app.close();
    const config = { ...stack.config, tenancy: "multi" as const };
    const app = buildGateway(config, stack.provider, {
      surface: "combined-test",
      startCron: false,
    });
    await app.listen({ port: 0, host: "0.0.0.0" });
    const address = app.server.address();
    if (!address || typeof address !== "object") throw new Error("gateway has no address");
    stack.app = app;
    base = `http://127.0.0.1:${address.port}`;

    // Each workspace attaches to its existing, tenant-labelled container; nothing is recreated.
    for (const tenant of [A, B]) {
      const handle = await ctx().sandboxes.ensure(tenant.workspace);
      expect(handle.providerRef).toBe(tenant.handle.providerRef);
    }
    expect(stack.provider.specs.length).toBe(specsBefore);

    // Sessions survive the restart, and each still sees only its own tenant.
    const listA = await (await as(A.owner, "GET", "/api/workspaces")).text();
    const listB = await (await as(B.owner, "GET", "/api/workspaces")).text();
    expect(listA).toContain(A.workspace.id);
    expect(listA).not.toContain(B.workspace.id);
    expect(listB).toContain(B.workspace.id);
    expect(listB).not.toContain(A.workspace.id);
    expect(await (await readFile(B.owner, B.workspace.id)).text()).toBe("m4-secret-of-tenant-b");
    expect((await readFile(B.owner, A.workspace.id)).status).toBe(404);

    // Signing out ends access at once; the other tenant is untouched.
    expect((await as(B.owner, "POST", "/auth/logout")).status).toBe(200);
    expect((await readFile(B.owner, B.workspace.id)).status).toBe(401);
    expect((await readFile(A.owner, A.workspace.id)).status).toBe(200);
  }, 120_000);
});
