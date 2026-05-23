import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/runtime-profile-standard v0.1.0-alpha
 * Reference MultiAgentRuntime profile — files installed via
 * \`agentproto install runtime-profile/standard\`.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    "node:url",
    "node:path",
    "node:fs",
    "node:fs/promises",
  ],
  noExternal: [],
})
