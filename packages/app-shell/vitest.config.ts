import { defineConfig } from "vitest/config"
import { maxWorkers } from "../../vitest.shared"

// Node by default; kit.test.ts opts into jsdom per file.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    poolOptions: {
      threads: { maxThreads: maxWorkers() },
      forks: { maxForks: maxWorkers() },
    },
  },
})
