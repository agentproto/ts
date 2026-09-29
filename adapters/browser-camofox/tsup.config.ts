import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-browser-camofox
 * Camofox browser provider: REST client, BrowserDriver, idempotent launch, health mapping.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod", "@agentproto/driver-browser"],
  noExternal: [],
})
