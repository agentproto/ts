import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/browser-profiles
 * Browser session and profile model: descriptors, Chrome profile discovery, camofox sessions, and the injection seams.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [
    "zod",
    "@agentproto/driver-browser",
    "@agentproto/tool",
    "node:child_process",
    "node:crypto",
    "node:fs",
    "node:os",
    "node:path",
  ],
  noExternal: [],
})
