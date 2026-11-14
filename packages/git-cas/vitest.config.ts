import { defineConfig } from "vitest/config"
import { maxWorkers } from "../../vitest.shared"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Every case spawns real git processes against scratch repos.
    testTimeout: 30_000,
    poolOptions: {
      threads: { maxThreads: maxWorkers() },
      forks: { maxForks: maxWorkers() },
    },
  },
})
