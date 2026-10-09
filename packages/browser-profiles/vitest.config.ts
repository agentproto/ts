import { defineConfig } from "vitest/config"
import VITEST_MAX_WORKERS from "../../vitest.shared"

export default defineConfig({
  test: {
    setupFiles: ["./src/__tests__/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    poolOptions: { threads: { maxThreads: VITEST_MAX_WORKERS } },
  },
})
