import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-mastra-agent v0.1.0-alpha
 * First-party agentproto agent: AGENT.md -> Mastra agent -> ACP server.
 */`,
  // Two entries: the manifest/handle (`index`) and the standalone CLI bin
  // (`cli`). The handle is self-locating — it spawns `node ./cli.mjs acp`
  // relative to its own dist location, so the same build works whether the
  // daemon spawns it or a user runs `agentproto-mastra acp` directly.
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  splitting: true,
  dts: { entry: { index: "src/index.ts" } },
  // @mastra/core is heavy + has its own provider graph — keep it external so
  // it resolves from the host's node_modules at runtime (same as the apps do).
  external: [
    "@agentproto/agent",
    "@agentproto/driver-agent-cli",
    "@agentproto/mastra",
    "@agentclientprotocol/sdk",
    "@mastra/core",
  ],
  noExternal: [],
})
