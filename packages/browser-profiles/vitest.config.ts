import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    setupFiles: ["./src/__tests__/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
