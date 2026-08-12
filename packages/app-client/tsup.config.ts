import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/app-client v0.1.0
 * Typed window.McpApp bridge client + TanStack Query hooks for app UIs.
 */`,
  entry: { index: "src/index.ts", react: "src/react.ts" },
  format: ["esm"],
  splitting: false,
  // dts emitted by `tsc -p tsconfig.build.json` (same split app-kit uses).
  dts: false,
  external: ["react", "react/jsx-runtime", "@tanstack/react-query"],
  noExternal: [],
})
