import { defineConfig } from "vitest/config"
import VITEST_MAX_WORKERS from "../../vitest.shared"

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    poolOptions: { threads: { maxThreads: VITEST_MAX_WORKERS } },
  },
})
