import { defineConfig } from "vitest/config"
import { maxWorkers } from "../../vitest.shared"

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    poolOptions: {
      threads: { maxThreads: maxWorkers() },
      forks: { maxForks: maxWorkers() },
    },
  },
})
