import { copyFile, cp } from "node:fs/promises";
await copyFile(
  new URL("../src/styles.css", import.meta.url),
  new URL("../dist/styles.css", import.meta.url),
);
await cp(new URL("../src/assets/", import.meta.url), new URL("../dist/assets/", import.meta.url), {
  recursive: true,
});
await cp(new URL("../legal/", import.meta.url), new URL("../dist/third-party/", import.meta.url), {
  recursive: true,
});
