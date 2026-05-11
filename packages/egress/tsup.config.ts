import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/egress v0.1.0-alpha
 * Outbound traffic control for agent sandboxes — mode registry,
 * proxy core, audit hooks. Cooperative mode delegates substitution
 * to @agentproto/secrets/exposure.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["@agentproto/secrets"],
  noExternal: [],
})
