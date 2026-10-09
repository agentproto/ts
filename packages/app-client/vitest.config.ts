import { defineConfig } from "vitest/config"
import { maxWorkers } from "../../vitest.shared"

// happy-dom for the react.ts hook tests (window, fetch stubs, DOM globals);
// the plain index.ts unwrap/mode tests run fine under it too.
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.tsx"],
    environment: "happy-dom",
    globals: false,
    poolOptions: {
      threads: { maxThreads: maxWorkers() },
      forks: { maxForks: maxWorkers() },
    },
  },
})
