/**
 * Store listing of an app: the APP.md `store:` block turned into the
 * `app-catalog/v1` listing fields (tagline, longDescription, screenshots,
 * icon, categories, publisher, homepage, repository) for `app pack --release
 * --entry`, plus the limit checks `catalog verify` re-runs on a published
 * entry. Limits live in the runtime (`CATALOG_LISTING_LIMITS`).
 *
 * ```yaml
 * store:
 *   tagline: Chat with any agentproto session.
 *   categories: [chat, sessions]
 *   publisher: Agentik
 *   homepage: https://agentproto.sh/apps/session-chat
 *   repository: https://github.com/acme/session-chat
 *   icon: store/icon.svg            # path in the app, or an https URL
 *   listing: store/LISTING.md       # long description (markdown)
 *   screenshots:
 *     - path: store/screenshots/thread.png   # or url: https://...
 *       alt: A session replayed as a chat thread
 * ```
 *
 * Local media are copied next to the entry (`media/<appId>/<version>/`) and
 * referenced as `<mediaBaseUrl>/<file>`; by default that is the public
 * `agentproto/apps` repo, where the entry PR adds them.
 */

import { readFile } from "node:fs/promises"
import { basename, isAbsolute, join, normalize, sep } from "node:path"

import { CATALOG_LISTING_LIMITS, type AppCatalogEntry } from "@agentproto/runtime/app-catalog"

/** Default home of first-party listing media: the public catalog repo. */
export function defaultMediaBaseUrl(appId: string, version: string): string {
  return `https://raw.githubusercontent.com/agentproto/apps/main/media/${appId}/${version}`
}

export type ListingFields = Pick<
  AppCatalogEntry,
  "tagline" | "longDescription" | "screenshots" | "icon" | "categories" | "publisher" | "homepage" | "repository"
>

export interface ListingMedia {
  /** Absolute path of the file in the app. */
  src: string
  /** File name it is published under (`<mediaBaseUrl>/<name>`). */
  name: string
}

export interface StoreListing {
  fields: ListingFields
  media: ListingMedia[]
}

export class StoreListingError extends Error {}

type ImageFormat = "png" | "jpeg" | "webp" | "svg"

/** Image format from its first bytes (the extension is not trusted). */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg"
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "webp"
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase()
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg"
  return undefined
}

/** Pixel size of a png (IHDR) or jpeg (first SOFn), else undefined. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const fmt = sniffImageFormat(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (fmt === "png" && bytes.length >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (fmt === "jpeg") {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return undefined
      const marker = bytes[i + 1]!
      const len = view.getUint16(i + 2)
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) }
      i += 2 + len
    }
  }
  return undefined
}

const isHttps = (v: unknown): v is string => typeof v === "string" && /^https:\/\/[^\s]+$/i.test(v)
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined)

/** Resolve an app-relative path, refusing anything outside the app. */
function appPath(appDir: string, rel: string, what: string): string {
  if (isAbsolute(rel)) throw new StoreListingError(`store.${what}: '${rel}' must be relative to the app`)
  const abs = normalize(join(appDir, rel))
  if (abs !== appDir && !abs.startsWith(appDir.endsWith(sep) ? appDir : appDir + sep)) {
    throw new StoreListingError(`store.${what}: '${rel}' points outside the app`)
  }
  return abs
}

/**
 * Problems with an entry's listing fields (limits, https, alt text). Shared
 * by `app pack --entry` (before writing) and `catalog verify`. Media bytes
 * are checked separately (`checkMediaBytes`).
 */
export function listingIssues(fields: ListingFields): string[] {
  const L = CATALOG_LISTING_LIMITS
  const issues: string[] = []
  if (fields.tagline !== undefined && (fields.tagline.length === 0 || fields.tagline.length > L.taglineMaxChars)) {
    issues.push(`tagline must be 1 to ${L.taglineMaxChars} characters (got ${fields.tagline.length})`)
  }
  if (fields.longDescription !== undefined && fields.longDescription.length > L.longDescriptionMaxChars) {
    issues.push(`longDescription exceeds ${L.longDescriptionMaxChars} characters (got ${fields.longDescription.length})`)
  }
  const shots = fields.screenshots ?? []
  if (shots.length > L.screenshotsMax) issues.push(`at most ${L.screenshotsMax} screenshots (got ${shots.length})`)
  shots.forEach((s, i) => {
    if (!isHttps(s.url)) issues.push(`screenshots[${i}].url must be an https URL (got "${s.url}")`)
    const alt = (s.alt ?? "").trim()
    if (alt.length === 0) issues.push(`screenshots[${i}].alt is required`)
    else if (alt.length > L.altMaxChars) issues.push(`screenshots[${i}].alt exceeds ${L.altMaxChars} characters`)
  })
  if (fields.icon !== undefined && !isHttps(fields.icon)) issues.push(`icon must be an https URL (got "${fields.icon}")`)
  const cats = fields.categories ?? []
  if (cats.length > L.categoriesMax) issues.push(`at most ${L.categoriesMax} categories (got ${cats.length})`)
  for (const c of cats) {
    if (!L.categoryPattern.test(c)) issues.push(`category '${c}' must match ${L.categoryPattern}`)
  }
  for (const k of ["homepage", "repository"] as const) {
    const v = fields[k]
    if (v !== undefined && !isHttps(v)) issues.push(`${k} must be an https URL (got "${v}")`)
  }
  return issues
}

/** Problems with one media file's bytes: format and size cap. */
export function checkMediaBytes(bytes: Uint8Array, kind: "screenshot" | "icon", label: string): string[] {
  const L = CATALOG_LISTING_LIMITS
  const issues: string[] = []
  const fmt = sniffImageFormat(bytes)
  const allowed: readonly ImageFormat[] = kind === "icon" ? ["png", "jpeg", "webp", "svg"] : ["png", "jpeg", "webp"]
  if (fmt === undefined || !allowed.includes(fmt)) {
    issues.push(`${label} must be ${allowed.join("/")} (detected ${fmt ?? "unknown"})`)
  }
  const max = kind === "icon" ? L.iconMaxBytes : L.screenshotMaxBytes
  if (bytes.byteLength > max) issues.push(`${label} is ${bytes.byteLength} bytes, over the ${max} byte cap`)
  return issues
}

/**
 * Read the APP.md `store:` block of `appDir` (absolute) into listing fields
 * plus the local media to publish. Returns `undefined` when there is no
 * `store:` block. Throws StoreListingError on any invalid value, so a pack
 * never writes an entry that `catalog verify` would reject.
 */
export async function readStoreListing(
  appDir: string,
  front: Record<string, unknown>,
  opts: { mediaBaseUrl: string },
): Promise<StoreListing | undefined> {
  const store = front.store
  if (store === undefined || store === null) return undefined
  if (typeof store !== "object" || Array.isArray(store)) throw new StoreListingError("store must be a mapping")
  const s = store as Record<string, unknown>
  const base = opts.mediaBaseUrl.replace(/\/+$/, "")
  const fields: ListingFields = {}
  const media: ListingMedia[] = []
  const issues: string[] = []
  const usedNames = new Set<string>()

  const addLocal = async (rel: string, what: string, kind: "screenshot" | "icon"): Promise<{ url: string; bytes: Uint8Array }> => {
    const src = appPath(appDir, rel, what)
    const bytes = new Uint8Array(await readFile(src).catch(() => {
      throw new StoreListingError(`store.${what}: cannot read '${rel}'`)
    }))
    issues.push(...checkMediaBytes(bytes, kind, `store.${what} ('${rel}')`))
    const name = basename(src)
    if (usedNames.has(name)) throw new StoreListingError(`store.${what}: two media files are named '${name}'`)
    usedNames.add(name)
    media.push({ src, name })
    return { url: `${base}/${encodeURIComponent(name)}`, bytes }
  }

  const tagline = str(s.tagline)
  if (tagline !== undefined) fields.tagline = tagline
  const publisher = str(s.publisher)
  if (publisher !== undefined) fields.publisher = publisher
  for (const k of ["homepage", "repository"] as const) {
    const v = str(s[k])
    if (v !== undefined) fields[k] = v
  }
  if (s.categories !== undefined) {
    if (!Array.isArray(s.categories) || !s.categories.every((c) => typeof c === "string")) {
      throw new StoreListingError("store.categories must be a list of strings")
    }
    fields.categories = s.categories.map((c: string) => c.trim())
  }
  const listing = str(s.listing)
  if (listing !== undefined) {
    const text = (await readFile(appPath(appDir, listing, "listing"), "utf8").catch(() => {
      throw new StoreListingError(`store.listing: cannot read '${listing}'`)
    })).trim()
    if (text !== "") fields.longDescription = text
  }
  const icon = str(s.icon)
  if (icon !== undefined) {
    fields.icon = isHttps(icon) ? icon : (await addLocal(icon, "icon", "icon")).url
  }
  if (s.screenshots !== undefined) {
    if (!Array.isArray(s.screenshots)) throw new StoreListingError("store.screenshots must be a list")
    const shots: NonNullable<ListingFields["screenshots"]> = []
    for (let i = 0; i < s.screenshots.length; i++) {
      const raw = s.screenshots[i] as Record<string, unknown> | null
      if (raw === null || typeof raw !== "object") throw new StoreListingError(`store.screenshots[${i}] must be a mapping`)
      const alt = str(raw.alt) ?? ""
      const path = str(raw.path)
      const url = str(raw.url)
      if ((path === undefined) === (url === undefined)) {
        throw new StoreListingError(`store.screenshots[${i}] needs exactly one of path or url`)
      }
      if (path !== undefined) {
        const local = await addLocal(path, `screenshots[${i}]`, "screenshot")
        const size = imageSize(local.bytes)
        shots.push({ url: local.url, alt, ...(size ?? {}) })
      } else {
        const w = typeof raw.width === "number" ? raw.width : undefined
        const h = typeof raw.height === "number" ? raw.height : undefined
        shots.push({ url: url!, alt, ...(w !== undefined ? { width: w } : {}), ...(h !== undefined ? { height: h } : {}) })
      }
    }
    if (shots.length > 0) fields.screenshots = shots
  }

  issues.push(...listingIssues(fields))
  if (issues.length > 0) throw new StoreListingError(issues.join("; "))
  return { fields, media }
}
