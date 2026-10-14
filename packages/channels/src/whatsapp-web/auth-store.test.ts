import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebAuthStore } from "./auth-store.js";

const roots: string[] = [];
const stores: WebAuthStore[] = [];
const root = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "deskmates-wa-"));
  roots.push(dir);
  return dir;
};
const open = (dir: string): WebAuthStore => {
  const store = new WebAuthStore(dir);
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("operator-only linked session storage", () => {
  it("restores credentials, binary Signal keys and echo IDs with private permissions", async () => {
    const dir = root();
    const store = open(dir);
    store.saveCreds({ registered: true, me: { id: "15550001111@s.whatsapp.net", name: "Test" } });
    await store.state.keys.set({ session: { peer: Buffer.from([1, 3, 5]) } });
    store.rememberOutbound("outbound-1");
    store.close();
    const restored = open(dir);
    expect(restored.state.creds.registered).toBe(true);
    expect((await restored.state.keys.get("session", ["peer"])).peer).toEqual(
      Buffer.from([1, 3, 5]),
    );
    expect(restored.isOutbound("outbound-1")).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "session.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "session.lock")).mode & 0o777).toBe(0o600);
  });
  it("rejects concurrent processes without disturbing the live owner", () => {
    const dir = root();
    const first = open(dir);
    expect(() => open(dir)).toThrow("already in use");
    first.rememberOutbound("still-owned");
    expect(first.isOutbound("still-owned")).toBe(true);
  });
  it("keeps corrupt session evidence and releases its lock", () => {
    const dir = root();
    writeFileSync(join(dir, "session.json"), "corrupt");
    expect(() => open(dir)).toThrow();
    expect(readFileSync(join(dir, "session.json"), "utf8")).toBe("corrupt");
    expect(() => statSync(join(dir, "session.lock"))).toThrow();
  });
  it("restores the last committed snapshot after an interrupted atomic write", () => {
    const dir = root();
    const first = open(dir);
    first.rememberOutbound("committed");
    first.close();
    writeFileSync(join(dir, "session.json.next"), "partial");
    expect(open(dir).isOutbound("committed")).toBe(true);
  });
  it("recovers a dead process lock without allowing a second live owner", () => {
    const dir = root();
    writeFileSync(join(dir, "session.lock"), "2147483647");
    const restored = open(dir);
    restored.rememberOutbound("restored");
    expect(() => open(dir)).toThrow("already in use");
  });
  it("logout replaces credentials, erases keys and outbound IDs", async () => {
    const first = open(root());
    first.saveCreds({ registered: true });
    await first.state.keys.set({ session: { peer: Buffer.from([7]) } });
    first.rememberOutbound("old");
    first.reset();
    expect(first.state.creds.registered).toBe(false);
    expect(await first.state.keys.get("session", ["peer"])).toEqual({});
    expect(first.isOutbound("old")).toBe(false);
  });
  it("refuses symlinked session material", () => {
    const dir = root();
    const other = root();
    const target = join(other, "untouched");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(dir, "session.json"));
    expect(() => open(dir)).toThrow("regular file");
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });
});
