import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    exclude: ["**/integration.e2b.test.ts", "**/node_modules/**"],
  },
})
