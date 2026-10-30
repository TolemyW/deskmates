// The golden-site image is tagged by its task-set version, not by a hash of its inputs, so a
// floating base tag would change the image deskbench runs against under an unchanged tag. The
// digest makes a new base a reviewed change to the Dockerfile (#63 L20); check it without Docker.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");

describe("packages/golden-site/Dockerfile", () => {
  it("pins its one base image by digest", () => {
    expect([...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1])).toEqual([
      expect.stringMatching(/^node:22-alpine@sha256:[0-9a-f]{64}$/),
    ]);
  });
});
