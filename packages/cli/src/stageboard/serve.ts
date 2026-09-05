/**
 * Serve the stage board module over the `app serve` / `app dev` HTTP
 * surfaces. The module is a plain `.js` asset (no build step); tsup copies
 * it to `dist/stageboard.js` on build, and in the source tree it lives next
 * to this file — `new URL("./stageboard.js", import.meta.url)` resolves the
 * right one in both layouts (the bundle inlines this module into
 * `dist/cli.mjs`, so the relative URL lands on `dist/stageboard.js`).
 */

import { readFile } from "node:fs/promises"
import type { ServerResponse } from "node:http"

/** Reserved route the stage board ES module is served from. */
export const STAGEBOARD_JS_PATH = "/agentproto/stageboard.js"

const STAGEBOARD_SOURCE_URL = new URL("./stageboard.js", import.meta.url)

/** Read the stageboard module source off disk. */
export async function readStageboardSource(): Promise<string> {
  return readFile(STAGEBOARD_SOURCE_URL, "utf8")
}

/**
 * Serve `GET /agentproto/stageboard.js` with
 * `content-type: text/javascript; charset=utf-8` (required for
 * `<script type="module">`) and no-store caching (dev: never stale).
 * Returns false when `urlPath` is not the stageboard route so the caller
 * falls through to its next handler.
 */
export async function serveStageboard(res: ServerResponse, urlPath: string): Promise<boolean> {
  if (urlPath !== STAGEBOARD_JS_PATH) return false
  try {
    const source = await readStageboardSource()
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    })
    res.end(source)
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        error: "stageboard_unavailable",
        message: err instanceof Error ? err.message : String(err),
      }),
    )
  }
  return true
}
