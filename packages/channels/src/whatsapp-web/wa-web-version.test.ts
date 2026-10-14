import { describe, expect, it, vi } from "vitest";
import { parseWaWebVersion, resolveWaWebVersion } from "./wa-web-version.js";

describe("WhatsApp Web protocol version", () => {
  it.each([
    ['self.__WB_MANIFEST = [{"client_revision":1049994111}]', [2, 3000, 1049994111]],
    ['{\\"client_revision\\": 1049994222}', [2, 3000, 1049994222]],
  ] as const)("parses the current revision from the service worker", (source, expected) => {
    expect(parseWaWebVersion(source)).toEqual(expected);
  });

  it.each(["", '{"client_revision":"not-a-number"}', '{"other":1049994111}'])(
    "rejects a service worker without a numeric revision",
    (source) => {
      expect(parseWaWebVersion(source)).toBeUndefined();
    },
  );

  it("uses the configured proxy for version discovery", async () => {
    const download = vi.fn(async () => '{"client_revision":1049994333}');
    await expect(resolveWaWebVersion("http://127.0.0.1:7890", download)).resolves.toEqual([
      2, 3000, 1049994333,
    ]);
    expect(download).toHaveBeenCalledWith("http://127.0.0.1:7890");
  });

  it("falls back to Baileys defaults when discovery fails or cannot be parsed", async () => {
    await expect(
      resolveWaWebVersion(undefined, async () => {
        throw new Error("offline");
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveWaWebVersion(undefined, async () => "no revision"),
    ).resolves.toBeUndefined();
  });
});
