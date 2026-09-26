import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/review v0.1.0
 * REVIEW.md manifest, compile-to-workflow, verdict + attestation contract.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["zod", "gray-matter", "@agentproto/workflow"],
  noExternal: [],
})
