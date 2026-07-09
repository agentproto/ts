import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-pi v0.1.0
 * AIP-45 proprietary protocol arm for earendil-works/pi, driven over pi's
 * persistent JSON-over-stdio RPC mode (\`pi --mode rpc\`) as a spawned child.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/driver-agent-cli"],
  noExternal: [],
})
