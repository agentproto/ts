import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["**/integration.e2b.test.ts"],
  },
})
