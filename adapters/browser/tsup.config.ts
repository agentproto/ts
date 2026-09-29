import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-browser v0.1.0-alpha
 * Browser service adapters — Camofox + Bureau process handles.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/adapter-browser-camofox", "@agentproto/adapter-browser-chromium", "@agentproto/browser-process", "@agentproto/driver-browser"],
  noExternal: [],
})
