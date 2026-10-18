import { defineConfig } from "vitest/config"
import { maxWorkers } from "../../vitest.shared"

export default defineConfig({
  test: {
    exclude: ["**/integration.*.test.ts", "**/node_modules/**"],
    poolOptions: {
      threads: { maxThreads: maxWorkers() },
      forks: { maxForks: maxWorkers() },
    },
  },
})
