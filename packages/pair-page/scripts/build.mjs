#!/usr/bin/env node
/**
 * Build the pair page into dist/, the static bundle the edge Worker serves:
 *
 *   dist/index.html              the one document (every app route)
 *   dist/assets/app-<hash>.js    the page (src/main.ts + @agentproto/pair-client)
 *   dist/assets/app-<hash>.css   its styles
 *   dist/pair-sw.js              the service worker (fixed name, max scope /)
 *   dist/manifest.webmanifest, dist/icon*.{svg,png}
 *
 * Everything is self-hosted: no CDN, no web fonts, no inline script or style
 * (the Worker serves `script-src 'self'; style-src 'self'`). The last step
 * checks the document for that.
 */

import { build } from "esbuild"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "dist")
const dev = process.env.NODE_ENV === "development"

await rm(dist, { recursive: true, force: true })
await mkdir(path.join(dist, "assets"), { recursive: true })

const common = {
  bundle: true,
  platform: "browser",
  target: ["es2022", "safari16"],
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  legalComments: "none",
  logLevel: "warning",
}

const page = await build({
  ...common,
  entryPoints: [path.join(root, "src/main.ts")],
  outdir: path.join(dist, "assets"),
  entryNames: "app-[hash]",
  format: "esm",
  metafile: true,
})

await build({
  ...common,
  entryPoints: [path.join(root, "src/sw.ts")],
  outfile: path.join(dist, "pair-sw.js"),
  format: "iife",
})

const outputs = Object.keys(page.metafile.outputs).map(f => path.relative(dist, path.resolve(f)))
const js = outputs.find(f => f.endsWith(".js"))
const css = outputs.find(f => f.endsWith(".css"))
if (!js || !css) throw new Error(`build: expected one .js and one .css output, got ${outputs.join(", ")}`)

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#0d1512" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="referrer" content="no-referrer" />
    <title>agentproto · pair</title>
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/icon-192.png" />
    <link rel="stylesheet" href="/${css}" />
    <script type="module" src="/${js}"></script>
  </head>
  <body>
    <main id="app"></main>
    <noscript>This page needs JavaScript to pair with your agentproto daemon.</noscript>
  </body>
</html>
`
await writeFile(path.join(dist, "index.html"), html)
await cp(path.join(root, "public"), dist, { recursive: true })

// Guard the CSP: the document loads only same-origin files, and has no inline
// script, style or event handler.
const doc = await readFile(path.join(dist, "index.html"), "utf8")
const problems = [
  [/<script(?![^>]*\ssrc=")[^>]*>/i, "inline <script>"],
  [/<style/i, "inline <style>"],
  [/\sstyle=/i, "style attribute"],
  [/\son[a-z]+=/i, "inline event handler"],
  [/(?:src|href)="(?:https?:)?\/\//i, "cross-origin src/href"],
].filter(([re]) => re.test(doc))
if (problems.length) throw new Error(`build: index.html breaks the CSP: ${problems.map(([, what]) => what).join(", ")}`)

console.log(`pair-page: dist/index.html, dist/${js}, dist/${css}, dist/pair-sw.js`)
