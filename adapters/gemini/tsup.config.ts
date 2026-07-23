import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-gemini v0.1.0-alpha
 * AIP-45 adapter for Google's Gemini CLI in ACP mode (\`gemini --experimental-acp\`).
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/driver-agent-cli"],
  noExternal: [],
})
