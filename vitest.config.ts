import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: "/tmp/wechat-clawbot-vite",
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: { reporter: ["text", "json-summary"] },
  },
});
