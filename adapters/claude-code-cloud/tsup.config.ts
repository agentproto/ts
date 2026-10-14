import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-claude-code-cloud v0.1.0
 * AIP-66 managed cloud agent adapter: Claude Code cloud sessions behind ACP.
 */`,
  // Two entries: the manifest/handle (`index`) and the ACP server the daemon
  // (and the bin/ launcher) spawns. The handle is self-locating — it spawns
  // `node <pkg>/bin/claude-code-cloud-acp.mjs` relative to its own dist
  // location, so the same build works whether the daemon resolves it from
  // node_modules or a user runs the published bin directly.
  entry: { index: "src/index.ts", "acp-server": "src/acp-server.ts" },
  format: ["esm"],
  splitting: true,
  dts: { entry: { index: "src/index.ts" } },
  external: [
    "@agentproto/driver-agent-cli",
    "@agentproto/adapter-claude-sdk",
    "@agentclientprotocol/sdk",
  ],
  noExternal: [],
})
