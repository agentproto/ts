import { defineConfig } from "vitest/config"
import { maxWorkers } from "../../vitest.shared"

// Node by default; dom.test.ts opts into jsdom per file, and the round-trip
// test builds its own JSDOM window for the panel-bridge guest.
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    globals: false,
    poolOptions: {
      threads: { maxThreads: maxWorkers() },
      forks: { maxForks: maxWorkers() },
    },
  },
})
