import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `#!/usr/bin/env node
/**
 * create-agentproto-app v0.1.0
 * Scaffold an agentproto agent app (Vite + TanStack ui/ + .agentproto shell).
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: false,
  dts: false,
  external: ["gray-matter"],
  noExternal: [],
})
