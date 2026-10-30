// T1 (ADR-0048 amendment 1, A3): two bots' desktop proxies on one shared screen. A scripted lease
// store stands in for the Gateway's (whose rules `gateway/src/desktop/desktop-input-lock.test.ts`
// proves; the packages never import each other). Focus-free calls of two bots are dispatched while
// both are open; a raw-input call keeps the other bot's call from being dispatched until it
// answers, and its lease is released by its result; a human takeover interrupts both bots' calls
// in flight and dispatches nothing after it.

import { PassThrough } from "node:stream";
import type { DesktopLeaseMode } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import {
  type DesktopChild,
  type DesktopLease,
  type DesktopLock,
  DesktopProxy,
} from "./desktop-proxy.js";

interface Msg {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

/** The Gateway's lease rules in miniature: shared together, exclusive alone, a human stops all. */
class Screen {
  readonly leases = new Map<string, DesktopLeaseMode>();
  human = false;
  epoch = 1;
  lockFor(run: string): DesktopLock {
    return {
      acquire: async (callId, mode): Promise<DesktopLease> => {
        if (this.human) return { granted: false, waitMessage: "A human holds the screen." };
        const key = `${run}/${callId}`;
        const others = [...this.leases].filter(([k]) => k !== key).map(([, m]) => m);
        const busy = mode === "exclusive" ? others.length > 0 : others.includes("exclusive");
        if (busy) return { granted: false, contended: true, waitMessage: "busy" };
        this.leases.set(key, mode);
        return { granted: true, epoch: this.epoch };
      },
      renew: async (callId) =>
        this.human || !this.leases.has(`${run}/${callId}`)
          ? { granted: false }
          : { granted: true, epoch: this.epoch },
      release: async (callId) => this.leases.delete(`${run}/${callId}`),
    };
  }
}

/** An LCU that holds every `js` call open until the test answers it. */
class HeldLcu implements DesktopChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly calls: Msg[] = [];
  constructor() {
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const m = JSON.parse(buffer.slice(0, nl)) as Msg;
        buffer = buffer.slice(nl + 1);
        if (m.method === "tools/call" && m.params?.name !== "turn_ended") this.calls.push(m);
      }
    });
  }
  answer(id: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [] } })}\n`);
  }
  kill(): void {
    this.stdout.end();
  }
}

function bot(screen: Screen, run: string) {
  const out: Msg[] = [];
  const upstream = new PassThrough();
  upstream.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) out.push(JSON.parse(line));
  });
  const children: HeldLcu[] = [];
  const proxy = new DesktopProxy(upstream, {
    spawn: () => {
      const child = new HeldLcu();
      children.push(child);
      return child;
    },
    lock: screen.lockFor(run),
    runId: run,
    attempt: 1,
    renewMs: 5,
    graceMs: 10,
    shutdownMs: 5,
    contentionPollMs: 2,
    contentionWaitMs: 2_000,
    log: () => {},
  });
  proxy.start();
  const send = (id: number, code: string) =>
    proxy.fromSdk(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "js", arguments: { code } },
      }),
    );
  return { proxy, out, children, send, lcu: () => children[children.length - 1] as HeldLcu };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("two bots on one shared screen (ADR-0048 amendment 1, A3)", () => {
  it("dispatches both bots' focus-free calls at once", async () => {
    const screen = new Screen();
    const nova = bot(screen, "run-nova");
    const vega = bot(screen, "run-vega");
    await nova.send(1, "const s = await cua.getState(); s");
    await vega.send(1, "await el('Save').doAction(0)");
    expect(nova.lcu().calls).toHaveLength(1);
    expect(vega.lcu().calls).toHaveLength(1);
    expect([...screen.leases.values()]).toEqual(["shared", "shared"]);
    nova.lcu().answer(1);
    vega.lcu().answer(1);
    await tick(5);
    expect(screen.leases.size).toBe(0);
  });

  it("holds the other bot's call back while a raw-input call runs, then dispatches it", async () => {
    const screen = new Screen();
    const nova = bot(screen, "run-nova");
    const vega = bot(screen, "run-vega");
    await nova.send(1, "await w.type('héllo')");
    expect([...screen.leases.values()]).toEqual(["exclusive"]);
    const waiting = vega.send(1, "const s = await cua.getState(); s");
    await tick(20);
    expect(vega.lcu().calls).toHaveLength(0);
    nova.lcu().answer(1);
    await waiting;
    expect(vega.lcu().calls).toHaveLength(1);
    expect([...screen.leases.values()]).toEqual(["shared"]);
    // And the other way round: a raw-input call waits for the shared one to answer.
    const typing = nova.send(2, "await w.press('ctrl+a')");
    await tick(20);
    expect(nova.lcu().calls).toHaveLength(1);
    vega.lcu().answer(1);
    await typing;
    expect(nova.lcu().calls).toHaveLength(2);
  });

  it("interrupts both bots' calls on a takeover and dispatches nothing after it", async () => {
    const screen = new Screen();
    const nova = bot(screen, "run-nova");
    const vega = bot(screen, "run-vega");
    await nova.send(1, "await cua.screenshot()");
    await vega.send(1, "const s = await cua.getState(); s");
    screen.human = true;
    await tick(40);
    for (const b of [nova, vega])
      expect(JSON.stringify(b.out.find((m) => m.id === 1)?.result)).toContain(
        "desktop_call_interrupted: a human took over",
      );
    await nova.send(2, "await cua.screenshot()");
    expect(JSON.stringify(nova.out.find((m) => m.id === 2)?.result)).toContain(
      "A human holds the screen.",
    );
    expect(nova.children.flatMap((c) => c.calls).filter((m) => m.id === 2)).toEqual([]);
  });
});
