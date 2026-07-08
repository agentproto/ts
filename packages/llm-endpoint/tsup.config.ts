import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/llm-endpoint v0.1.0-alpha
 * Anthropic-Messages-compatible proxy gateway. One Claude API surface,
 * many upstream providers (Moonshot / OpenRouter / ZAI / Groq) behind
 * stable alias codenames. Schema translation, tool-cap trimming,
 * orphaned-tool-call repair, thinking-block stripping.
 */`,
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: { entry: { index: "src/index.ts" } },
  external: [
    "node:http",
    "node:https",
    "node:fs",
    "node:url",
  ],
  noExternal: [],
})
