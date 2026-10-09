import { defineConfig } from "vitest/config"
import VITEST_MAX_WORKERS from "../../vitest.shared"

export default defineConfig({
  test: {
    exclude: ["**/integration.e2b.test.ts", "**/node_modules/**"],
    poolOptions: { threads: { maxThreads: VITEST_MAX_WORKERS } },
  },
})
