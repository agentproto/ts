/**
 * Stable ids, URL canonicalisation and text fingerprints.
 *
 * Hashing uses Web Crypto (`crypto.subtle`, async), which exists in Node 20+,
 * browsers and edge runtimes. No Node built-in is imported.
 */

/** Query parameters that only carry tracking information. */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "twclid",
  "ttclid",
  "mc_cid",
  "mc_eid",
  "ref_src",
  "ref_url",
  "igshid",
  "si",
  "_hsenc",
  "_hsmi",
  "mkt_tok",
])

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
}

function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase()
  return key.startsWith("utm_") || TRACKING_PARAMS.has(key)
}

/**
 * Clean an http(s) URL into a dedup key: lowercase scheme and host (the path
 * keeps its case), no credentials, no fragment, no default port, tracking
 * parameters removed, remaining parameters ordered by key only (the relative
 * order of a repeated key is kept, so `?a=2&a=1` differs from `?a=1&a=2`), no
 * trailing slash (root included, so `/a/` and `/a` are the same key).
 *
 * The result is only a key for deduplication: the original URL is always
 * kept next to it. Callers pass the final URL; redirects are not followed
 * here, so a known redirect target must be resolved before calling.
 *
 * Any non-http(s) scheme (`mailto:`, `urn:`, `data:`, ...) and any input that
 * is not an absolute URL is returned trimmed and otherwise unchanged.
 */
export function canonicalUrl(input: string): string {
  const raw = input.trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return raw
  url.hash = ""
  url.username = ""
  url.password = ""
  if (DEFAULT_PORTS[url.protocol] === url.port) url.port = ""

  const kept: Array<[string, string]> = []
  url.searchParams.forEach((value, name) => {
    if (!isTrackingParam(name)) kept.push([name, value])
  })
  // Array.prototype.sort is stable: equal keys keep their original order.
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const query = new URLSearchParams(kept).toString()

  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : ""
  return `${url.protocol}//${url.host}${path}${query ? `?${query}` : ""}`
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Id of an item that has a platform id: `source:nativeId`. Strings are used
 * as given; a number must be a safe integer (larger ids lose digits, so pass
 * them as strings) or this throws.
 */
export function itemId(source: string, nativeId: string | number): string {
  if (typeof nativeId === "number" && !Number.isSafeInteger(nativeId)) {
    throw new RangeError(`native id ${nativeId} is not a safe integer; pass it as a string`)
  }
  return `${source}:${String(nativeId)}`
}

/** Id of an item without a platform id: `source:` plus a hash of its canonical URL. */
export async function itemIdFromUrl(source: string, url: string): Promise<string> {
  return `${source}:${await sha256Hex(canonicalUrl(url))}`
}

/** Text reduced to lowercase words separated by single spaces. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
}

/**
 * Exact-content id: SHA-256 of the normalised text. Same words, same
 * fingerprint. Text that normalises to nothing (empty, only punctuation or
 * symbols) has no content id: returns `undefined`, so unrelated empty items
 * never share one.
 */
export async function textFingerprint(text: string): Promise<string | undefined> {
  const normalized = normalizeText(text)
  return normalized === "" ? undefined : sha256Hex(normalized)
}
