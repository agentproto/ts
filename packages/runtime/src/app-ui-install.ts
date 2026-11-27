/**
 * Installable app UI (AIP-53 "Installable UI"): the web app manifest the
 * daemon derives from an installed app's APP.md, the icons it serves, and the
 * `<head>` tags it injects into the served UI document, so a browser can offer
 * "Install" (Chrome) or "Add to Dock" (Safari).
 *
 * URL shape, for an app UI served at `<prefix>/apps/<id>/ui`:
 *   <prefix>/apps/<id>/manifest.webmanifest
 *   <prefix>/apps/<id>/icons/<n>
 * Every URL is a path-absolute reference built from the request's own prefix,
 * so it follows the daemon's port, a tunnel or a relay prefix.
 */

import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, sep } from "node:path"

import matter from "gray-matter"
import { isSafeRelativeIconPath } from "@agentproto/app"

import type { InstalledApp } from "./app-registry.js"

export const DEFAULT_THEME_COLOR = "#111114"
const ICON_MAX_BYTES = 2 * 1024 * 1024
const SHORT_NAME_MAX = 12

export type IconType = "image/png" | "image/svg+xml" | "image/webp"

/** Image type from the first bytes — the extension is never trusted. */
export function sniffIconType(bytes: Uint8Array): IconType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png"
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp"
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase()
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml"
  return undefined
}

export interface InstallIcon {
  /** Path relative to the app dir; absent for the generated icon. */
  readonly path?: string
  readonly sizes: string
  readonly purpose?: string
}

/** The pieces of an installed app the manifest needs. */
export type InstallableApp = Pick<InstalledApp, "appId" | "dir" | "name"> & {
  readonly ui?: { readonly title?: string; readonly install?: AppInstallConfig }
}
interface AppInstallConfig {
  readonly shortName?: string
  readonly themeColor?: string
  readonly backgroundColor?: string
  readonly display?: string
  readonly icons?: readonly { readonly path: string; readonly sizes?: string; readonly purpose?: string }[]
}

/** `store.icon` of the app's APP.md when it is a safe app-relative path. */
async function storeIconPath(dir: string): Promise<string | undefined> {
  try {
    const fm = matter(await readFile(join(dir, ".agentproto", "APP.md"), "utf8")).data as {
      store?: { icon?: unknown }
    }
    const icon = fm.store?.icon
    return typeof icon === "string" && isSafeRelativeIconPath(icon) && /\.(png|svg|webp)$/i.test(icon) ? icon : undefined
  } catch {
    return undefined
  }
}

/** Declared icons, else the store listing icon, else the generated one. */
export async function resolveInstallIcons(app: InstallableApp): Promise<readonly InstallIcon[]> {
  const declared = app.ui?.install?.icons
  if (declared && declared.length > 0) {
    return declared.map(i => ({
      path: i.path,
      sizes: i.sizes ?? (/\.svg$/i.test(i.path) ? "any" : "512x512"),
      ...(i.purpose !== undefined ? { purpose: i.purpose } : {}),
    }))
  }
  const store = await storeIconPath(app.dir)
  if (store) return [{ path: store, sizes: store.toLowerCase().endsWith(".svg") ? "any" : "512x512" }]
  return [{ sizes: "any" }]
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): string => {
    const k = (n + h / 30) % 12
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * c).toString(16).padStart(2, "0")
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/** The app's colour: declared, else one derived from its id (stable). */
export function appThemeColor(app: InstallableApp): string {
  return app.ui?.install?.themeColor ?? hslToHex(hash(app.appId) % 360, 0.45, 0.32)
}

export function appDisplayName(app: InstallableApp): string {
  return app.name?.trim() || app.ui?.title?.trim() || app.appId
}

function appInitials(name: string): string {
  const words = name.replace(/^@/, "").split(/[\s/_-]+/).filter(Boolean)
  const letters = words.length > 1 ? words.slice(0, 2).map(w => w[0]!) : [...(words[0] ?? "?")].slice(0, 2)
  return letters.join("").toUpperCase()
}

const escapeXml = (s: string): string =>
  s.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!)

/** Generated fallback: the app's initials on its colour (a maskable-safe square). */
export function generatedIconSvg(app: InstallableApp): string {
  const initials = escapeXml(appInitials(appDisplayName(app)))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${appThemeColor(app)}"/>` +
    `<text x="256" y="256" fill="#ffffff" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="210" font-weight="600" ` +
    `text-anchor="middle" dominant-baseline="central">${initials}</text></svg>`
  )
}

export interface ServedIcon {
  readonly bytes: Buffer
  readonly type: IconType
}

/**
 * The bytes of icon `index`, or undefined when it does not exist or is not
 * safe to serve: the real path must stay inside the app dir and the content
 * must be an image (the extension decides nothing).
 */
export async function readInstallIcon(app: InstallableApp, index: number): Promise<ServedIcon | undefined> {
  const icons = await resolveInstallIcons(app)
  const icon = icons[index]
  if (!icon) return undefined
  if (icon.path === undefined) return { bytes: Buffer.from(generatedIconSvg(app), "utf8"), type: "image/svg+xml" }
  if (!isSafeRelativeIconPath(icon.path)) return undefined
  try {
    const root = await realpath(app.dir)
    const target = await realpath(isAbsolute(icon.path) ? icon.path : join(app.dir, icon.path))
    if (!target.startsWith(root.endsWith(sep) ? root : root + sep)) return undefined
    const st = await stat(target)
    if (!st.isFile() || st.size > ICON_MAX_BYTES) return undefined
    const bytes = await readFile(target)
    const type = sniffIconType(bytes)
    return type ? { bytes, type } : undefined
  } catch {
    return undefined
  }
}

export interface AppWebManifest {
  readonly name: string
  readonly short_name: string
  readonly id: string
  readonly start_url: string
  readonly scope: string
  readonly display: string
  readonly theme_color: string
  readonly background_color: string
  readonly icons: readonly { src: string; sizes: string; type: IconType; purpose?: string }[]
}

/** Path prefix `<prefix>/apps/<id>` of a request path under an app, or undefined. */
export function appBasePath(requestPath: string): string | undefined {
  return /^(.*\/apps\/.+?)\/(?:ui\/?|manifest\.webmanifest|icons\/\d+)$/.exec(requestPath)?.[1]
}

/** The web app manifest for an installed app, URLs rooted at `base`. */
export async function buildAppManifest(app: InstallableApp, base: string): Promise<AppWebManifest> {
  const name = appDisplayName(app)
  const theme = appThemeColor(app)
  const icons = await resolveInstallIcons(app)
  const served = await Promise.all(icons.map((_, i) => readInstallIcon(app, i)))
  return {
    name,
    short_name: app.ui?.install?.shortName ?? ([...name].length > SHORT_NAME_MAX ? [...name].slice(0, SHORT_NAME_MAX).join("") : name),
    id: `${base}/ui`,
    start_url: `${base}/ui`,
    scope: `${base}/`,
    display: app.ui?.install?.display ?? "standalone",
    theme_color: theme,
    background_color: app.ui?.install?.backgroundColor ?? theme,
    // An icon that cannot be served is left out, never advertised as a 404.
    icons: icons.flatMap((icon, i) => {
      const s = served[i]
      return s ? [{ src: `${base}/icons/${i}`, sizes: icon.sizes, type: s.type, ...(icon.purpose ? { purpose: icon.purpose } : {}) }] : []
    }),
  }
}

const hasManifestLink = (html: string): boolean => /<link\b[^>]*\brel\s*=\s*["']?manifest\b/i.test(html)

const escapeAttr = (s: string): string => s.replace(/[&"<>]/g, c => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!)

/** The `<head>` tags to inject, or "" when the document brings its own manifest link. */
export function installHeadTags(html: string, app: InstallableApp, base: string, appleIconIndex: number | undefined): string {
  if (hasManifestLink(html)) return ""
  return (
    `<link rel="manifest" href="${escapeAttr(base)}/manifest.webmanifest">` +
    `<meta name="theme-color" content="${appThemeColor(app)}">` +
    `<meta name="apple-mobile-web-app-title" content="${escapeAttr(app.ui?.install?.shortName ?? appDisplayName(app).slice(0, SHORT_NAME_MAX))}">` +
    (appleIconIndex !== undefined ? `<link rel="apple-touch-icon" href="${escapeAttr(base)}/icons/${appleIconIndex}">` : "")
  )
}

/** Index of the icon best suited to `apple-touch-icon`: the largest png, else the first. */
export function appleIconIndex(icons: readonly InstallIcon[]): number | undefined {
  if (icons.length === 0) return undefined
  let best = 0
  let bestSize = -1
  icons.forEach((icon, i) => {
    const size = Math.max(0, ...[...icon.sizes.matchAll(/(\d+)x\d+/g)].map(m => Number(m[1])))
    const png = icon.path !== undefined && /\.png$/i.test(icon.path) ? 1 : 0
    const score = png * 100000 + size
    if (score > bestSize) { best = i; bestSize = score }
  })
  return best
}

/** Insert `tags` right after `<head>` (else at the top of the document). */
export function injectIntoHead(html: string, tags: string): string {
  if (tags === "") return html
  const m = /<head[^>]*>/i.exec(html)
  if (m?.index !== undefined) return html.slice(0, m.index + m[0].length) + tags + html.slice(m.index + m[0].length)
  const h = /<html[^>]*>/i.exec(html)
  if (h?.index !== undefined) return html.slice(0, h.index + h[0].length) + `<head>${tags}</head>` + html.slice(h.index + h[0].length)
  return tags + html
}
