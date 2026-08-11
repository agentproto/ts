/**
 * Development server for the Rift UI demo.
 *
 * Serves static files from public/ directory. No backend logic,
 * no API endpoints — the demo runs entirely client-side.
 */

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { join, extname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const publicDir = join(__dirname, "..", "public")
const port = process.env.PORT ? parseInt(process.env.PORT) : 3000

const mimeTypes: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
}

const server = createServer(async (req, res) => {
  try {
    let filepath = req.url === "/" ? "/index.html" : req.url || "/index.html"

    // Security: prevent directory traversal
    if (filepath.includes("..")) {
      res.writeHead(400)
      res.end("Bad Request")
      return
    }

    const fullPath = join(publicDir, filepath)
    const ext = extname(fullPath)
    const contentType = mimeTypes[ext] || "application/octet-stream"

    const content = await readFile(fullPath)
    res.writeHead(200, { "Content-Type": contentType })
    res.end(content)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      res.writeHead(404)
      res.end("Not Found")
    } else {
      res.writeHead(500)
      res.end("Internal Server Error")
    }
  }
})

server.listen(port, () => {
  console.log(`✓ Rift UI server running at http://localhost:${port}`)
  console.log(`  Press Ctrl+C to stop`)
})
