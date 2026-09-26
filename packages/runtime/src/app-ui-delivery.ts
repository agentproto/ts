/**
 * HTTP delivery primitives for the app-UI shell — `GET /apps/:appId/ui` and
 * `GET /apps/:appId/ui/assets/:file` on the daemon (http-server.ts), and the
 * same shapes under `agentproto app serve` (cli/src/app-serve.ts). One
 * module so both hosts negotiate, validate and cache identically:
 *
 *   - `accept-encoding` negotiation (`br` preferred, then `gzip`, else
 *     identity) with `vary: accept-encoding` on every response.
 *   - A strong `etag` (sha256 of the exact bytes served) answered with 304
 *     on a matching `if-none-match`.
 *   - An LRU of encoded representations keyed by a caller-chosen key and
 *     invalidated by a caller-chosen stamp (path + mtime + size for files),
 *     so neither the digest nor the compression reruns until the file
 *     changes.
 *
 * Deliberately scoped to the shell: SSE, MCP and every API route keep their
 * own framing and never go through here.
 */

import { createHash } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib"

export type ContentCoding = "br" | "gzip" | "identity"

/** Pick the response coding from an `accept-encoding` header: `br` when
 *  acceptable, then `gzip`, else identity. q-values are honoured only as
 *  acceptable (`q>0`) vs refused (`q=0`) — the preference order is ours, not
 *  the client's. A `*` entry covers codings the header doesn't name. */
export function negotiateContentEncoding(header: string | string[] | undefined): ContentCoding {
  const raw = Array.isArray(header) ? header.join(",") : header
  if (!raw) return "identity"
  const q = new Map<string, number>()
  for (const part of raw.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";")
    if (!name) continue
    let weight = 1
    for (const p of params) {
      const m = p.trim().match(/^q=([0-9.]+)$/)
      if (m) weight = Number(m[1])
    }
    q.set(name === "x-gzip" ? "gzip" : name, Number.isFinite(weight) ? weight : 0)
  }
  const acceptable = (coding: string): boolean => {
    const v = q.get(coding) ?? q.get("*")
    return v !== undefined && v > 0
  }
  if (acceptable("br")) return "br"
  if (acceptable("gzip")) return "gzip"
  return "identity"
}

/** Strong entity tag over `body` (sha256, base64url). `variant`, when set,
 *  is appended so two representations of the same bytes that carry
 *  different response headers (e.g. with/without frame headers) never
 *  validate each other's cache entry. */
export function strongEtag(body: Buffer | string, variant?: string): string {
  const digest = createHash("sha256").update(body).digest("base64url")
  return variant ? `"${digest}-${variant}"` : `"${digest}"`
}

/** `if-none-match` evaluation (RFC 9110 §13.1.2): `*` or any listed tag
 *  equal to `etag` under weak comparison. */
export function ifNoneMatchHits(header: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(header) ? header.join(",") : header
  if (!raw) return false
  const bare = etag.replace(/^W\//, "")
  for (const part of raw.split(",")) {
    const tag = part.trim()
    if (tag === "*") return true
    if (tag.replace(/^W\//, "") === bare) return true
  }
  return false
}

/** Content types the app-UI routes serve, by lowercase extension. */
export const APP_UI_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
}

/** Content type for an extension (with or without the leading dot). */
export function appUiContentType(ext: string): string {
  const key = (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase()
  return APP_UI_MIME_BY_EXT[key] ?? "application/octet-stream"
}

/** Whether a content type is worth compressing — text-ish only; woff2/png
 *  and friends are already compressed. */
export function isCompressibleContentType(contentType: string): boolean {
  const base = contentType.split(";")[0]!.trim().toLowerCase()
  return (
    base.startsWith("text/") ||
    base === "application/json" ||
    base === "application/javascript" ||
    base === "image/svg+xml" ||
    base === "application/wasm"
  )
}

/** `:file` segment of the assets route: a flat name from `[A-Za-z0-9._-]`,
 *  not starting with `.` (so no `.`/`..`, no dotfiles), no separators. */
export function isValidAppUiAssetName(file: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(file)
}

/** Assets route cache policy — Vite emits content-hashed file names. */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"

/** One servable body, its strong etag, and its encodings (computed lazily,
 *  memoized — a representation that is never requested as gzip never pays
 *  for it). */
export interface EncodedRepresentation {
  readonly etag: string
  readonly compressible: boolean
  body(coding: ContentCoding): Buffer
}

export function createEncodedRepresentation(
  identity: Buffer,
  opts: { compressible: boolean; etag?: string },
): EncodedRepresentation {
  const encoded = new Map<ContentCoding, Buffer>([["identity", identity]])
  return {
    etag: opts.etag ?? strongEtag(identity),
    compressible: opts.compressible,
    body(coding) {
      const hit = encoded.get(coding)
      if (hit) return hit
      const out =
        coding === "br"
          ? brotliCompressSync(identity, {
              params: {
                [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
                [zlibConstants.BROTLI_PARAM_SIZE_HINT]: identity.length,
              },
            })
          : gzipSync(identity, { level: 6 })
      encoded.set(coding, out)
      return out
    },
  }
}

/** Small LRU of representations. `stamp` is whatever identifies the source
 *  version (e.g. `${mtimeMs}:${size}`); a stamp mismatch rebuilds. Bounded
 *  because some keys fold in request-derived input (the injected base URL). */
export interface RepresentationCache {
  get(
    key: string,
    stamp: string,
    build: () => Promise<EncodedRepresentation> | EncodedRepresentation,
  ): Promise<EncodedRepresentation>
  readonly size: number
}

export function createRepresentationCache(maxEntries = 64): RepresentationCache {
  const entries = new Map<string, { stamp: string; rep: EncodedRepresentation }>()
  return {
    async get(key, stamp, build) {
      const hit = entries.get(key)
      if (hit && hit.stamp === stamp) {
        entries.delete(key)
        entries.set(key, hit)
        return hit.rep
      }
      const rep = await build()
      entries.delete(key)
      entries.set(key, { stamp, rep })
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
      return rep
    },
    get size() {
      return entries.size
    },
  }
}

/** Write `rep` to `res` with `headers` (content-type, cache-control, frame
 *  headers — whatever the route decided), adding `etag`, `vary:
 *  accept-encoding`, `content-encoding` and `content-length`. A matching
 *  `if-none-match` answers 304 with the same headers and no body, so a
 *  revalidation refreshes the stored headers exactly as a 200 would. */
export function sendRepresentation(
  req: IncomingMessage,
  res: ServerResponse,
  rep: EncodedRepresentation,
  headers: Record<string, string>,
): void {
  // Merge, don't clobber: the daemon's CORS layer may already have set
  // `Vary: Origin` via setHeader, which a writeHead `vary` would replace.
  const prior = res.getHeader("vary")
  const priorVary = Array.isArray(prior) ? prior.join(", ") : prior === undefined ? "" : String(prior)
  const vary = /(^|,)\s*accept-encoding\s*(,|$)/i.test(priorVary)
    ? priorVary
    : priorVary
      ? `${priorVary}, accept-encoding`
      : "accept-encoding"
  const out: Record<string, string> = { ...headers, etag: rep.etag, vary }
  if (ifNoneMatchHits(req.headers["if-none-match"], rep.etag)) {
    res.writeHead(304, out)
    res.end()
    return
  }
  const coding = rep.compressible ? negotiateContentEncoding(req.headers["accept-encoding"]) : "identity"
  const body = rep.body(coding)
  if (coding !== "identity") out["content-encoding"] = coding
  out["content-length"] = String(body.length)
  res.writeHead(200, out)
  res.end(req.method === "HEAD" ? undefined : body)
}
