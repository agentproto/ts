import { defineConfig } from "vitest/config"
import { maxWorkers } from "../../vitest.shared"

export default defineConfig({
  test: {
    poolOptions: {
      threads: { maxThreads: maxWorkers() },
      forks: { maxForks: maxWorkers() },
    },
  },
})
