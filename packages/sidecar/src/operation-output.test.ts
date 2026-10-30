// T0: where `image_generate` writes (ADR-0040 amendment B, decision 20), on a temporary root that
// stands for the container's `/`.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createImageOutputs } from "./operation-output.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskmates-image-out-"));
  mkdirSync(join(root, "work/bots"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const NOW = new Date("2026-10-17T11:15:00.123Z");
const png = (fill: number) => ({ mediaType: "image/png" as const, bytes: Buffer.alloc(8, fill) });

describe("createImageOutputs", () => {
  it("writes each image under the bot's own images directory and names it uniquely", async () => {
    const outputs = createImageOutputs({ root });
    const paths = await outputs.write(
      "nova",
      "op_01HZX9ABCDEF",
      [png(1), { mediaType: "image/webp", bytes: Buffer.alloc(4, 2) }],
      NOW,
    );
    expect(paths).toEqual([
      "/work/bots/nova/images/20261017T111500Z-X9ABCDEF-1.png",
      "/work/bots/nova/images/20261017T111500Z-X9ABCDEF-2.webp",
    ]);
    expect(readFileSync(join(root, paths[0] ?? ""))).toEqual(Buffer.alloc(8, 1));
    // A second call in the same second with another operation id does not collide.
    const more = await outputs.write("nova", "op_01HZX9ABCDEG", [png(3)], NOW);
    expect(more).toEqual(["/work/bots/nova/images/20261017T111500Z-X9ABCDEG-1.png"]);
    expect(readdirSync(join(root, "work/bots/nova/images"))).toHaveLength(3);
  });

  it("never overwrites an existing file", async () => {
    const outputs = createImageOutputs({ root });
    await outputs.write("nova", "op_same", [png(1)], NOW);
    await expect(outputs.write("nova", "op_same", [png(2)], NOW)).rejects.toThrow(/EEXIST/);
    const [name] = readdirSync(join(root, "work/bots/nova/images"));
    expect(readFileSync(join(root, "work/bots/nova/images", name ?? ""))).toEqual(
      Buffer.alloc(8, 1),
    );
  });

  it("refuses an images directory or a bot directory that links elsewhere", async () => {
    mkdirSync(join(root, "work/bots/nova"));
    mkdirSync(join(root, "work/bots/vega/images"), { recursive: true });
    symlinkSync(join(root, "work/bots/vega/images"), join(root, "work/bots/nova/images"));
    const outputs = createImageOutputs({ root });
    await expect(outputs.write("nova", "op_1", [png(1)], NOW)).rejects.toThrow(/leaves/);
    expect(readdirSync(join(root, "work/bots/vega/images"))).toEqual([]);

    symlinkSync(join(root, "work/bots/vega"), join(root, "work/bots/orion"));
    await expect(outputs.write("orion", "op_2", [png(1)], NOW)).rejects.toThrow(/leaves/);
    expect(readdirSync(join(root, "work/bots/vega/images"))).toEqual([]);
  });

  it("refuses a bot name that is not one directory", async () => {
    const outputs = createImageOutputs({ root });
    for (const name of ["", "..", "a/b"])
      await expect(outputs.write(name, "op_1", [png(1)], NOW)).rejects.toThrow(/bot directory/);
  });
});
