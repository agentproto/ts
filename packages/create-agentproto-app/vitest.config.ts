import { defineConfig } from "vitest/config"

// Unit tests live under src/ only. The `templates/` trees ship app-skeleton
// files (including a trame `tests/gate.test.mjs` written for node:test, to
// run inside a SCAFFOLDED app) — vitest must not pick those up as suites.
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  },
})
