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
 * Clean a URL so that two links to the same page compare equal: lowercase
 * scheme and host, no credentials, no fragment, no default port, no tracking
 * parameters, remaining parameters sorted, no trailing slash (root included).
 * Returns the trimmed input unchanged when it is not an absolute URL.
 */
export function canonicalUrl(input: string): string {
  const raw = input.trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  url.hash = ""
  url.username = ""
  url.password = ""
  if (DEFAULT_PORTS[url.protocol] === url.port) url.port = ""

  const kept: Array<[string, string]> = []
  url.searchParams.forEach((value, name) => {
    if (!isTrackingParam(name)) kept.push([name, value])
  })
  kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
  const query = new URLSearchParams(kept).toString()

  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : ""
  return `${url.protocol}//${url.host}${path}${query ? `?${query}` : ""}`
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Id of an item that has a platform id: `source:nativeId`. */
export function itemId(source: string, nativeId: string | number): string {
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

/** Exact-content id: SHA-256 of the normalised text. Same words, same fingerprint. */
export async function textFingerprint(text: string): Promise<string> {
  return sha256Hex(normalizeText(text))
}
