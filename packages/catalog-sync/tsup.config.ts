import { createTsupConfig } from "@agentproto/tooling/tsup/base"

/**
 * catalog-sync ships two surfaces: the library (index/types/runner/generators)
 * and the `catalog-sync` CLI (bin). Splitting is OFF so each entry is a
 * standalone bundle — the CLI inlines runner + generators and has no runtime
 * dependency on the library chunks.
 */
export default createTsupConfig({
  banner: `/**
 * @agentproto/catalog-sync v0.1.0
 * Build-time generator framework for @agentproto/model-catalog.
 * Generates *.generated.ts from pinned provider sources.
 */`,
  entry: {
    index: "src/index.ts",
    types: "src/types.ts",
    runner: "src/runner.ts",
    bin: "src/bin.ts",
    "generators/llm-openrouter": "src/generators/llm-openrouter.ts",
    "generators/llm-requesty": "src/generators/llm-requesty.ts",
    "refresh-workflow": "src/refresh-workflow.ts",
    "sources/openai": "src/sources/openai.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["zod"],
  noExternal: [],
})
