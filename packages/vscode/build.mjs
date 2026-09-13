// esbuild bundler for the agentproto VS Code extension.
// Bundles src/extension.ts → dist/extension.js as a CommonJS module so the
// VS Code extension host (Node, CommonJS) can load it as `main`.
// `vscode` is the host-provided API and must stay external.
//
// Also bundles the transcript panel's embedded xterm.js view:
//   src/webview/xtermBundle.entry.ts → dist/webview/xterm.iife.js
//   src/webview/xtermBundle.css     → dist/webview/xterm.css
// Both are inlined into buildHtml's output so the webview needs no external
// script src (and therefore no CSP connect-src / credential leak).

import { build, context } from "esbuild"

const watch = process.argv.includes("--watch")

/** @type {import("esbuild").BuildOptions} */
const extensionOptions = {
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

/** @type {import("esbuild").BuildOptions} */
const xtermJsOptions = {
  entryPoints: ["src/webview/xtermBundle.entry.ts"],
  bundle: true,
  outfile: "dist/webview/xterm.iife.js",
  platform: "browser",
  format: "iife",
  globalName: "AgentprotoXterm",
  target: "es2020",
  sourcemap: false,
  logLevel: "info",
}

/** @type {import("esbuild").BuildOptions} */
const xtermCssOptions = {
  entryPoints: ["src/webview/xtermBundle.css"],
  bundle: true,
  outfile: "dist/webview/xterm.css",
  platform: "browser",
  sourcemap: false,
  logLevel: "info",
}

async function buildAll() {
  await Promise.all([
    build(extensionOptions),
    build(xtermJsOptions),
    build(xtermCssOptions),
  ])
}

if (watch) {
  const extensionCtx = await context(extensionOptions)
  const xtermJsCtx = await context(xtermJsOptions)
  const xtermCssCtx = await context(xtermCssOptions)
  await Promise.all([extensionCtx.watch(), xtermJsCtx.watch(), xtermCssCtx.watch()])
} else {
  await buildAll()
}
