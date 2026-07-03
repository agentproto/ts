import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-claude-sdk v0.1.0-alpha
 * First-party agentproto adapter: Claude Agent SDK headless query() -> ACP server.
 */`,
  // Two entries: the manifest/handle (`index`) and the standalone CLI bin
  // (`cli`). The handle is self-locating — it spawns `node ./cli.mjs acp`
  // relative to its own dist location, so the same build works whether the
  // daemon spawns it or a user runs `agentproto-claude-sdk acp` directly.
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  splitting: true,
  dts: { entry: { index: "src/index.ts" } },
  // The Claude Agent SDK ships its own (heavy) bundled harness + MCP graph —
  // keep it external so it resolves from the host's node_modules at runtime.
  external: [
    "@agentproto/driver-agent-cli",
    "@agentclientprotocol/sdk",
    "@anthropic-ai/claude-agent-sdk",
  ],
  noExternal: [],
})
