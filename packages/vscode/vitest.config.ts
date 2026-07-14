import { defineConfig } from "vitest/config"

// Pure-logic tests only — no VS Code extension host. The vscode module
// is mocked via an alias so modules that import it for types/events load
// under plain Node without pulling the real @types/vscode runtime.
export default defineConfig({
  resolve: {
    alias: {
      vscode: new URL("./src/test/vscode-mock.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
})
