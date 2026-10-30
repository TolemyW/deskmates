// Where `image_generate` puts the images it receives (ADR-0040 amendment B, decision 20): the
// bot's own directory, `/work/bots/<bot>/images/` (ADR-0038 decision 1), in every working-directory
// mode. Each file is created exclusively, so nothing is overwritten, and an images directory that
// resolves outside the bot's directory (a link) is refused.

import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { type GeneratedImageMediaType, botWorkDir } from "@deskmates/contracts";
import { OperationInputError } from "./operation-input.js";

/** The subdirectory of a bot's working directory that holds its generated images. */
export const GENERATED_IMAGES_DIR = "images";

const EXTENSIONS: Record<GeneratedImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export interface ImageOutputs {
  /**
   * Write the images of one operation; returns their container paths in order. `now` names the
   * files, so two calls never share a name; the operation id makes them unique within a second.
   */
  write(
    botName: string,
    operationId: string,
    images: readonly { mediaType: GeneratedImageMediaType; bytes: Buffer }[],
    now: Date,
  ): Promise<string[]>;
}

/** `20261017T111500Z`: sortable, no characters a shell or a URL would need to quote. */
function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** The real writer. `root` stands for the container's `/`; tests pass a temporary directory. */
export function createImageOutputs(opts: { root?: string } = {}): ImageOutputs {
  const root = opts.root ?? "/";
  return {
    async write(botName, operationId, images, now) {
      if (botName === "" || botName.includes("/") || botName.includes("\0") || botName === "..")
        throw new OperationInputError(`${botName} is not a bot directory name`);
      const own = botWorkDir(botName);
      const dir = `${own}/${GENERATED_IMAGES_DIR}`;
      const physicalOwn = join(root, own);
      const physicalDir = join(root, dir);
      const leaves = () =>
        new OperationInputError(`${dir} leaves ${own}; generated images were not written`);
      // The bot's directory first, checked before anything is created inside it.
      await mkdir(physicalOwn, { recursive: true });
      const realOwn = await realpath(physicalOwn);
      if (realOwn !== join(await realpath(join(root, "/work/bots")), botName)) throw leaves();
      await mkdir(physicalDir).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
      if ((await realpath(physicalDir)) !== join(realOwn, GENERATED_IMAGES_DIR)) throw leaves();
      const realDir = join(realOwn, GENERATED_IMAGES_DIR);
      const suffix = operationId.replace(/[^A-Za-z0-9]/g, "").slice(-8) || "op";
      const paths: string[] = [];
      for (const [i, image] of images.entries()) {
        const name = `${stamp(now)}-${suffix}-${i + 1}.${EXTENSIONS[image.mediaType]}`;
        const handle = await open(
          join(realDir, name),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o644,
        );
        try {
          await handle.writeFile(image.bytes);
        } finally {
          await handle.close();
        }
        paths.push(`${dir}/${name}`);
      }
      return paths;
    },
  };
}
