import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["**/instabox.integration.test.ts"],
  },
})
