import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entryPath = fileURLToPath(new URL("../../../images/workspace/entry.sh", import.meta.url));

describe("workspace entry VNC authentication", () => {
  it("requires the effective 8-byte password and starts x11vnc with its protected auth file", async () => {
    const source = await readFile(entryPath, "utf8");
    expect(source).toContain("DESKMATES_VNC_PASSWORD is required");
    expect(source).toContain("^[0-9a-fA-F]{8}$");
    expect(source).toContain('-passwdfile "$VNC_PASSWORD_FILE"');
    expect(source).toContain("__BEGIN_VIEWONLY__");
    expect(source).toContain("a distinct eight-hex view password is required");
    expect(source).toContain('-clip "1280x720+$x+$y"');
    expect(source).not.toMatch(/x11vnc[^\n]*-nopw/);
  });

  it("forces Chromium and the host Gateway through the proxy, bypassing only loopback", async () => {
    const source = await readFile(entryPath, "utf8");
    expect(source).toContain(
      '--proxy-server="${DESKMATES_EGRESS_PROXY:?DESKMATES_EGRESS_PROXY is required}"',
    );
    expect(source).toContain('--proxy-bypass-list="localhost;127.0.0.1;[::1]"');
    expect(source).not.toMatch(/--proxy-bypass-list=[^\n]*host\.docker\.internal/);
  });
});
