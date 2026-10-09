import { defineConfig } from "vitest/config"
import { maxWorkers } from "../../vitest.shared"

export default defineConfig({
  test: {
    setupFiles: ["./src/__tests__/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    poolOptions: {
      threads: { maxThreads: maxWorkers() },
      forks: { maxForks: maxWorkers() },
    },
  },
})
