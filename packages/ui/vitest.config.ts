import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    setupFiles: ["./test-setup.ts"],
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
