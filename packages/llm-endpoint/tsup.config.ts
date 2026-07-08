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
  // Source imports use bare specifiers ('http', 'https', etc.) — keep the
  // external list in sync so tsup does not inline Node built-ins into the bundle.
  external: [
    "http",
    "https",
    "fs",
    "url",
  ],
  noExternal: [],
})
