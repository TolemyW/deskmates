// T2: real Linux process ancestry, no model, network, workspace volumes or shared services.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SandboxHandle, WorkspaceId } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerProvider } from "./docker-provider.js";

const helper = "/usr/local/lib/deskmates/run-supervisor.py";
const source = fileURLToPath(
  new URL("../../../images/workspace/run-supervisor.py", import.meta.url),
);
const shim = fileURLToPath(new URL("../../../images/workspace/deskmates-sidecar", import.meta.url));
const image =
  process.env.DESKMATES_SUPERVISOR_TEST_IMAGE ??
  process.env.WORKSPACE_IMAGE ??
  "deskmates/workspace:dev";
const provider = new DockerProvider();
const available = await provider.client.request("GET", "/_ping").then(
  (r) => r.status === 200,
  () => false,
);
if (!available) console.warn("[run-supervisor T2] Docker unavailable: real process checks skipped");

describe.skipIf(!available)("run descendant lifecycle (real Docker)", { timeout: 30000 }, () => {
  let handle: SandboxHandle;
  const runId = `run_${randomUUID().replaceAll("-", "")}`;
  const launch = (program: string, extra: Parameters<DockerProvider["exec"]>[1] = { cmd: [] }) =>
    provider.exec(handle, {
      ...extra,
      // Production shim, with a controlled child in place of the SDK/real model.
      cmd: extra.cmd.length > 0 ? extra.cmd : ["/bin/sh", "/work/deskmates-sidecar", "run"],
      env: {
        DESKMATES_RUN_ID: runId,
        PATH: "/work/bin:/usr/local/bin:/usr/bin:/bin",
        TEST_SIDECAR_PROGRAM: program,
        ...extra.env,
      },
    });
  const probe = (program: string) =>
    provider.exec(handle, { cmd: ["python3", "-c", program], timeoutMs: 5000 });
  const ready = async (name: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        (await probe(`import os; print(os.path.exists('/work/${name}'))`)).stdout.trim() === "True"
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`child not ready: ${name}`);
  };
  const assertGone = async (name: string) => {
    const r = await probe(
      `import os; p=open('/work/${name}').read(); print(os.path.exists('/proc/'+p))`,
    );
    expect(r.stdout.trim(), `descendant from ${name} must be reaped, not a zombie`).toBe("False");
  };

  beforeAll(async () => {
    // Do not pull: a missing prerequisite must remain visible, not become a network test.
    expect((await provider.client.request("GET", `/images/${image}/json`)).status).toBe(200);
    const { json } = await provider.client.expect<{ Id: string }>("POST", "/containers/create", {
      Image: image,
      Entrypoint: [],
      Cmd: ["python3", "-c", "import time; time.sleep(3600)"],
      Labels: { "deskmates.test": "run-supervisor", "deskmates.test.nonce": runId },
      HostConfig: {
        NetworkMode: "none",
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        PidsLimit: 128,
        Memory: 384 * 1024 * 1024,
        ReadonlyRootfs: true,
        Tmpfs: {
          "/tmp": "rw,exec,size=64m",
          "/work": "rw,exec,size=4m",
        },
      },
    });
    handle = {
      workspaceId: "t2-supervisor" as WorkspaceId,
      providerRef: json.Id,
      sidecarAddress: `docker-exec://${json.Id}`,
    };
    await provider.client.expect("POST", `/containers/${json.Id}/start`);
    const installed = await probe(`print(open('${helper}').read(),end='')`);
    expect(installed.exitCode, installed.stderr).toBe(0);
    expect(installed.stdout).toBe(readFileSync(source, "utf8"));
    await probe("import os; os.mkdir('/work/bin')");
    for (const [path, content] of [
      ["/work/deskmates-sidecar", readFileSync(shim, "utf8")],
      ["/work/bin/node", '#!/bin/sh\nexec python3 -c "$TEST_SIDECAR_PROGRAM"\n'],
    ] as const) {
      expect(
        await provider.exec(handle, {
          cmd: [
            "python3",
            "-c",
            `import os,sys; open('${path}','w').write(sys.stdin.read()); os.chmod('${path}',0o755)`,
          ],
          stdin: content,
        }),
      ).toMatchObject({ exitCode: 0, timedOut: false });
    }
  }, 30_000);

  afterAll(async () => {
    if (handle)
      await provider.client.request("DELETE", `/containers/${handle.providerRef}?force=true`);
  });

  // Parent keeps running so the old marker scan cannot clean up via normal process exit.
  function detached(name: string, doubleFork = false): string {
    return `import os,signal,time,sys
if os.fork() == 0:
 os.setsid()
 ${doubleFork ? "if os.fork() != 0: os._exit(0)" : "pass"}
 fd=os.open('/dev/null',os.O_RDWR)
 for target in (0,1,2): os.dup2(fd,target)
 os.execve(sys.executable,['python3','-c',"import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); open('/work/${name}','w').write(str(os.getpid())); time.sleep(60)"],{})
time.sleep(60)`;
  }

  it("preserves stdin, output and exit status, cleaning orphans even after normal exit", async () => {
    const r = await launch(
      "import sys,subprocess; print(sys.stdin.read()); print('err',file=sys.stderr); subprocess.Popen(['sleep','60']); sys.exit(7)",
      { cmd: [], stdin: "request-json\n", timeoutMs: 5000 },
    );
    expect(r).toEqual({
      stdout: "request-json\n\n",
      stderr: "err\n",
      exitCode: 7,
      timedOut: false,
    });
  });

  it.each([false, true])(
    "restart killRun reaps env-free setsid descendants (double fork=%s)",
    async (doubleFork) => {
      const name = doubleFork ? "double" : "single";
      const pending = launch(detached(name, doubleFork));
      await ready(name);
      // A new provider represents a new Gateway: no in-memory registry is required.
      await new DockerProvider().killRun(handle, runId);
      await assertGone(name);
      expect((await pending).exitCode).toBe(143);
    },
  );

  it("abort reaps the target but preserves another run and workspace process", async () => {
    const sibling = launch(detached("sibling", true), {
      cmd: [],
      env: { DESKMATES_RUN_ID: `${runId}_other` },
    });
    const controller = new AbortController();
    const target = launch(detached("aborted", true), { cmd: [], signal: controller.signal });
    await ready("sibling");
    await ready("aborted");
    controller.abort();
    expect((await target).timedOut).toBe(true);
    await assertGone("aborted");
    const surviving = await probe(
      "import os; p=open('/work/sibling').read(); print(os.path.exists('/proc/'+p)); print(os.path.exists('/proc/1'))",
    );
    expect(surviving.stdout).toBe("True\nTrue\n");
    await provider.killRun(handle, `${runId}_other`);
    await sibling;
    await assertGone("sibling");
  });

  it("timeout uses the same cleanup for a detached environment-free child", async () => {
    const r = await launch(detached("deadline", true), { cmd: [], timeoutMs: 1200 });
    expect(r.timedOut).toBe(true);
    await assertGone("deadline");
  });

  it("the image-installed sidecar shim supervises its descendants", async () => {
    const pending = launch(detached("installed", true), {
      cmd: ["/usr/local/bin/deskmates-sidecar", "run"],
    });
    await ready("installed");
    await provider.killRun(handle, runId);
    await pending;
    await assertGone("installed");
  });

  it("reaps a nested subreaper and its orphaned child", async () => {
    const p = launch(`import ctypes,os,time
if os.fork()==0:
 ctypes.CDLL(None).prctl(36,1,0,0,0)
 ${detached("nested", true).replaceAll("\n", "\n ")}
time.sleep(60)`);
    await ready("nested");
    await provider.killRun(handle, runId);
    await p;
    await assertGone("nested");
  });

  it.skipIf(process.env.DESKMATES_SUPERVISOR_BROWSER === "0")(
    "preserves a real workspace Chromium outside the cancelled run's ancestry",
    async () => {
      const startup = await probe(`import os,subprocess,time
browser=subprocess.check_output(['node','-e',"console.log(require('playwright').chromium.executablePath())"],cwd='/opt/deskmates',text=True).strip()
p=subprocess.Popen([browser,'--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--user-data-dir=/work/browser','about:blank'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=open('/work/browser.log','w'),start_new_session=True,env=dict(os.environ,HOME='/work',XDG_CONFIG_HOME='/work/config',XDG_CACHE_HOME='/work/cache'))
open('/work/browser.pid','w').write(str(p.pid))
time.sleep(0.5)
assert p.poll() is None,open('/work/browser.log').read()`);
      expect(startup, startup.stderr).toMatchObject({ exitCode: 0, timedOut: false });
      const target = launch(detached("browser-peer", true));
      await ready("browser-peer");
      await provider.killRun(handle, runId);
      await target;
      await assertGone("browser-peer");
      expect(
        await probe("import os; os.kill(int(open('/work/browser.pid').read()),0)"),
      ).toMatchObject({ exitCode: 0, timedOut: false });
    },
  );
});
