// esbuild bundler for the agentproto VS Code extension.
// Bundles src/extension.ts → dist/extension.js as a CommonJS module so the
// VS Code extension host (Node, CommonJS) can load it as `main`.
// `vscode` is the host-provided API and must stay external.

import { build, context } from "esbuild"

const watch = process.argv.includes("--watch")

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  sourcesContent: true,
  logLevel: "info",
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await build(options)
}
