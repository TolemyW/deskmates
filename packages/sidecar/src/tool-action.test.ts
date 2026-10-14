import { describe, expect, it } from "vitest";
import { isShellFetch, shellHosts, targetHost, toToolAction } from "./tool-action.js";

const SHOP = "http://shop.example.test:8080";

describe("isShellFetch", () => {
  it("matches curl and wget as commands, not as substrings", () => {
    expect(isShellFetch("curl -s https://a.test")).toBe(true);
    expect(isShellFetch("cd /work && wget -q https://a.test/f")).toBe(true);
    expect(isShellFetch("echo done; curl https://a.test")).toBe(true);
    expect(isShellFetch("cat curl.log")).toBe(false);
    expect(isShellFetch("mycurl https://a.test")).toBe(false);
    expect(isShellFetch("ls -la")).toBe(false);
  });

  it("matches a path-qualified or wrapped fetcher (review item 2)", () => {
    expect(isShellFetch("/usr/bin/curl https://evil.test")).toBe(true);
    expect(isShellFetch("./wget https://evil.test")).toBe(true);
    expect(isShellFetch("env curl https://evil.test")).toBe(true);
    expect(isShellFetch("env -i FOO=1 curl https://evil.test")).toBe(true);
    expect(isShellFetch("command curl https://evil.test")).toBe(true);
    expect(isShellFetch("exec curl https://evil.test")).toBe(true);
    expect(isShellFetch("echo https://evil.test | xargs curl")).toBe(true);
    expect(isShellFetch("nice curl https://evil.test")).toBe(true);
    expect(isShellFetch("timeout 5 curl https://evil.test")).toBe(true);
    expect(isShellFetch("sudo curl https://evil.test")).toBe(true);
    expect(isShellFetch('bash -c "curl https://evil.test"')).toBe(true);
    expect(isShellFetch("ls&&curl https://evil.test")).toBe(true);
    expect(isShellFetch("ls|curl https://evil.test")).toBe(true);
  });

  it("treats a fetcher resolved at run time as a fetch", () => {
    expect(isShellFetch("$(which curl) https://evil.test")).toBe(true);
    expect(isShellFetch("`which wget` https://evil.test")).toBe(true);
    expect(isShellFetch("which curl")).toBe(true);
    expect(isShellFetch("x=$(command -v curl); $x https://evil.test")).toBe(true);
  });

  it("does not match a fetcher name inside quotes or as part of a file name", () => {
    expect(isShellFetch("echo 'curl is installed'")).toBe(false);
    expect(isShellFetch("cat /work/curl-notes.txt")).toBe(false);
    expect(isShellFetch("ls /usr/bin/curl.d")).toBe(false);
    // A word that is exactly curl or wget counts wherever it sits: a copied binary at /work/curl
    // is still curl, and an unknown wrapper cannot hide it.
    expect(isShellFetch("/work/curl https://evil.test")).toBe(true);
  });
});

describe("shellHosts", () => {
  it("returns every http(s) host in the command, lower-cased", () => {
    expect(shellHosts("curl https://A.test/x -o /tmp/x; curl http://b.test:8080/y")).toEqual([
      "a.test",
      "b.test",
    ]);
  });

  it("returns an empty list when the target is not a literal URL", () => {
    expect(shellHosts("curl $(cat /tmp/target)")).toEqual([]);
    expect(shellHosts("curl example.com")).toEqual([]);
  });

  it("reads URLs from quoted and attached words (review item 2)", () => {
    expect(shellHosts("curl 'https://a.test/x?p=1&q=2'")).toEqual(["a.test"]);
    expect(shellHosts('curl "https://a.test/x" --url=https://b.test/y')).toEqual([
      "a.test",
      "b.test",
    ]);
    expect(shellHosts("wget --output-document=/tmp/f http://c.test/z")).toEqual(["c.test"]);
    expect(shellHosts('bash -c "curl https://d.test"')).toEqual(["d.test"]);
  });

  it("reports no readable URL when the fetcher itself is resolved at run time", () => {
    expect(shellHosts("$(which curl) https://evil.test")).toEqual([]);
    expect(shellHosts("`which wget` https://evil.test")).toEqual([]);
    expect(shellHosts("x=$(command -v curl); $x https://evil.test")).toEqual([]);
  });
});

describe("targetHost", () => {
  it("reads url, uri or href and lower-cases the host", () => {
    expect(targetHost({ url: "https://Ops.Example.test/dashboard" })).toBe("ops.example.test");
    expect(targetHost({ href: "http://a.test" })).toBe("a.test");
    expect(targetHost({ url: "not a url" })).toBeUndefined();
    expect(targetHost({})).toBeUndefined();
  });
});

// The dimensions an Always rule stores have to survive a re-snapshot and a reworded page
// (ADR-0002 amendment 2, A3): the origin comes from the last navigation the hook allowed, and the
// pattern keeps only the stable part of the arguments.
describe("toToolAction: stable rule dimensions", () => {
  it("gives a browser click the origin of the page the run last navigated to", () => {
    const nav = toToolAction("mcp__browser__browser_navigate", { url: `${SHOP}/checkout` });
    expect(nav.targetOrigin).toBe(SHOP);
    const click = toToolAction(
      "mcp__browser__browser_click",
      { element: "Submit order", ref: "e42" },
      { currentOrigin: nav.targetOrigin },
    );
    expect(click.targetOrigin).toBe(SHOP);
  });

  it("leaves a click before any navigation without an origin, so it matches no rule", () => {
    const click = toToolAction("mcp__browser__browser_click", { element: "Submit order" });
    expect(click.targetOrigin).toBeUndefined();
  });

  it("summarises a click by its element and patterns it by the side-effect phrase", () => {
    const click = toToolAction("mcp__browser__browser_click", {
      element: '  "Submit   order"  button',
      ref: "e42",
    });
    expect(click.argumentSummary).toBe("submit order button");
    expect(click.argumentPattern).toBe("*submit*");
  });

  it("falls back to the typed text, then the ref, when there is no element", () => {
    expect(toToolAction("browser_type", { text: "Pay Now" }).argumentSummary).toBe("pay now");
    expect(toToolAction("browser_click", { ref: "e42" }).argumentSummary).toBe("e42");
  });

  it("leaves a click with no side-effect phrase without a pattern", () => {
    const click = toToolAction("browser_click", { element: "Orders tab" });
    expect(click.argumentSummary).toBe("orders tab");
    expect(click.argumentPattern).toBeUndefined();
  });

  it("keeps a shell command's program and subcommand", () => {
    const push = toToolAction("Bash", { command: "git push  origin\n  main" });
    expect(push.argumentSummary).toBe("git push origin main");
    expect(push.argumentPattern).toBe("git push*");
  });

  it("keeps only the program when the next word is an option", () => {
    const rm = toToolAction("Bash", { command: "rm -rf /work/x" });
    expect(rm.argumentSummary).toBe("rm -rf /work/x");
    expect(rm.argumentPattern).toBe("rm*");
  });

  it("keeps only the program for a fetcher, whose next word is the URL", () => {
    expect(toToolAction("Bash", { command: "curl -sd a=1 https://x.test/p" }).argumentPattern).toBe(
      "curl *",
    );
    expect(toToolAction("Bash", { command: "/usr/bin/wget https://x.test" }).argumentPattern).toBe(
      "wget *",
    );
  });

  it("summarises navigation by its URL and gives it no pattern: the origin is the dimension", () => {
    const nav = toToolAction("browser_navigate", { url: `${SHOP}/checkout?a=1` });
    expect(nav.argumentSummary).toBe(`${SHOP}/checkout?a=1`);
    expect(nav.argumentPattern).toBeUndefined();
  });

  it("summarises a file write by its resolved path and gives it no pattern", () => {
    const write = toToolAction("Write", { file_path: "/work/../etc/hosts", content: "x" });
    expect(write.filePath).toBe("/work/../etc/hosts");
    expect(write.argumentSummary).toBe("/etc/hosts");
    expect(write.argumentPattern).toBeUndefined();
  });

  it("falls back to compact JSON of the input for anything else", () => {
    const other = toToolAction("mcp__db__query", { sql: "select 1" });
    expect(other.argumentSummary).toBe('{"sql":"select 1"}');
  });

  it("never returns a summary longer than 200 characters or spanning lines", () => {
    const long = "x".repeat(5000);
    for (const action of [
      toToolAction("Bash", { command: `echo ${long}\nrm -rf /` }),
      toToolAction("browser_click", { element: long }),
      toToolAction("Write", { file_path: `/work/${long}` }),
      toToolAction("mcp__db__query", { sql: long }),
    ]) {
      expect(action.argumentSummary?.length).toBeLessThanOrEqual(200);
      expect(action.argumentSummary).not.toContain("\n");
    }
  });
});
