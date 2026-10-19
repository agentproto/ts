import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/computer-api v0.1.0
 * `+"\n"+` * Versioned public contract for the computer controller HTTP API.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod"],
  noExternal: [],
})
