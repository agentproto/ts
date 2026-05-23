import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/agent-runtime v0.1.0-alpha
 * MultiAgentRuntime kernel — swappable ports + reference adapters
 * (file substrate, mention dispatcher, fs state, agent-cli participant).
 * Transport-specific adapters ship in separate packages.
 */`,
  entry: {
    index: "src/index.ts",
    ports: "src/ports.ts",
    manifest: "src/manifest.ts",
    "adapters/substrate-file": "src/adapters/substrate-file.ts",
    "adapters/dispatcher-mention": "src/adapters/dispatcher-mention.ts",
    "adapters/state-fs": "src/adapters/state-fs.ts",
    "adapters/participant-agent-cli": "src/adapters/participant-agent-cli.ts",
    "adapters/telemetry": "src/adapters/telemetry.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    "zod",
    "gray-matter",
    "node:fs",
    "node:fs/promises",
    "node:path",
    "node:crypto",
    "node:child_process",
    "node:events",
    "node:stream",
  ],
  noExternal: [],
})
