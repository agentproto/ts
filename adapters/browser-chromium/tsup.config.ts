import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-browser-chromium
 * Chromium browser provider: Playwright-launched Chromium on a dedicated profile dir.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod", "@agentproto/driver-browser", "playwright-core"],
  noExternal: [],
})
