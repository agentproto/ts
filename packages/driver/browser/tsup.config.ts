import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/driver-browser
 * Browser provider kit: defineBrowser, BrowserInstance, BrowserDriver, registry, capability gate.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [
    "zod",
    "@agentproto/define-doctype",
    "@agentproto/provider-kit",
    "@agentproto/tool",
  ],
  noExternal: [],
})
