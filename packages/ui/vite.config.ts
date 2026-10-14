import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { uiLegalAssets } from "./scripts/legal-assets.js";

export default defineConfig({
  root: fileURLToPath(new URL("./studio", import.meta.url)),
  plugins: [react(), tailwindcss(), uiLegalAssets()],
  server: { host: "127.0.0.1", port: 6006, strictPort: true },
  build: { outDir: "../dist-studio", emptyOutDir: true },
});
