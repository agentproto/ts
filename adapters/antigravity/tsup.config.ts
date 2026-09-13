import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-antigravity v0.1.0-alpha
 * AIP-45 adapter for Google Antigravity (\`agy\`) via its headless CLI mode.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/driver-agent-cli"],
  noExternal: [],
})
