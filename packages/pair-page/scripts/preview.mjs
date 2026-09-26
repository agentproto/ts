#!/usr/bin/env node
/**
 * Serve dist/ locally through the SAME edge handler the Worker runs
 * (src/edge.ts), so host checks and headers match production. For local
 * tests only; production is the Cloudflare Worker (wrangler.toml).
 *
 *   PORT            default 8788
 *   PAIR_DOMAIN     default "localhost": http://<fingerprint>.localhost:8788
 *                   is a daemon origin (Chrome resolves *.localhost to
 *                   loopback and treats it as a secure context)
 *   PREVIEW_HOSTS   default "localhost,127.0.0.1" (shared preview origin)
 */

import { build } from "esbuild"
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import os from "node:os"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "dist")
const port = Number(process.env.PORT ?? 8788)
const env = {
  PAIR_DOMAIN: process.env.PAIR_DOMAIN ?? "localhost",
  PREVIEW_HOSTS: process.env.PREVIEW_HOSTS ?? "localhost,127.0.0.1",
}

const edgeFile = path.join(os.tmpdir(), `pair-page-edge-${process.pid}.mjs`)
await build({ entryPoints: [path.join(root, "src/edge.ts")], outfile: edgeFile, bundle: true, format: "esm", platform: "node", logLevel: "warning" })
const { handleRequest } = await import(pathToFileURL(edgeFile).href)

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
}

/** A stand-in for the Workers static-assets binding: files from dist/, as named. */
const ASSETS = {
  async fetch(input) {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const file = path.join(dist, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ""))
    if (!file.startsWith(dist + path.sep)) return new Response("Not found", { status: 404 })
    try {
      const body = await readFile(file)
      return new Response(body, { headers: { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" } })
    } catch {
      return new Response("Not found", { status: 404 })
    }
  },
}

createServer(async (req, res) => {
  const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url}`
  const response = await handleRequest(new Request(url, { method: req.method, headers: req.headers }), { ...env, ASSETS })
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()))
}).listen(port, () => {
  console.log(`pair-page preview on http://localhost:${port} (daemon origins: http://<fingerprint>.${env.PAIR_DOMAIN}:${port})`)
})
