/**
 * Validation of `ui.install` (AIP-53 "Installable UI", conformance rule 14).
 * Shared by `defineApp` (TS authoring) and `loadAppHandle` (which hands the
 * raw frontmatter to `defineApp`), so both paths give the same diagnostic.
 */

import type { AppUiInstall, AppUiInstallIcon } from "./types.js"

export const UI_INSTALL_SHORT_NAME_MAX = 12
export const UI_INSTALL_ICONS_MAX = 8
export const UI_INSTALL_DISPLAYS = ["standalone", "minimal-ui", "browser"] as const
export const UI_INSTALL_PURPOSES = ["any", "maskable", "monochrome"] as const

const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const ICON_EXT_RE = /\.(png|svg|webp)$/i
const SIZES_RE = /^(any|[0-9]+x[0-9]+( [0-9]+x[0-9]+)*)$/
const INSTALL_KEYS = new Set(["shortName", "themeColor", "backgroundColor", "display", "icons"])
const ICON_KEYS = new Set(["path", "sizes", "purpose"])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** True for a relative path with no `..` segment and no drive/absolute root. */
export function isSafeRelativeIconPath(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) return false
  return !p.split(/[\\/]/).includes("..")
}

/** Validate and normalise `ui.install`; throws `fail(message)` on a violation. */
export function normalizeUiInstall(raw: unknown, fail: (message: string) => Error): AppUiInstall {
  if (!isRecord(raw)) throw fail("`ui.install` must be an object.")
  for (const key of Object.keys(raw)) {
    if (!INSTALL_KEYS.has(key)) throw fail(`\`ui.install.${key}\` is not a supported field.`)
  }
  const out: {
    shortName?: string
    themeColor?: string
    backgroundColor?: string
    display?: AppUiInstall["display"]
    icons?: readonly AppUiInstallIcon[]
  } = {}
  if (raw.shortName !== undefined) {
    if (typeof raw.shortName !== "string" || raw.shortName.length < 1 || raw.shortName.length > UI_INSTALL_SHORT_NAME_MAX) {
      throw fail(`\`ui.install.shortName\` must be 1 to ${UI_INSTALL_SHORT_NAME_MAX} characters.`)
    }
    out.shortName = raw.shortName
  }
  for (const key of ["themeColor", "backgroundColor"] as const) {
    const v = raw[key]
    if (v === undefined) continue
    if (typeof v !== "string" || !COLOR_RE.test(v)) throw fail(`\`ui.install.${key}\` must be a #rgb or #rrggbb colour.`)
    out[key] = v
  }
  if (raw.display !== undefined) {
    if (!(UI_INSTALL_DISPLAYS as readonly unknown[]).includes(raw.display)) {
      throw fail(`\`ui.install.display\` must be one of ${UI_INSTALL_DISPLAYS.join(", ")}.`)
    }
    out.display = raw.display as AppUiInstall["display"]
  }
  if (raw.icons !== undefined) {
    if (!Array.isArray(raw.icons) || raw.icons.length < 1 || raw.icons.length > UI_INSTALL_ICONS_MAX) {
      throw fail(`\`ui.install.icons\` must hold 1 to ${UI_INSTALL_ICONS_MAX} entries.`)
    }
    out.icons = Object.freeze(
      raw.icons.map((icon: unknown, i: number): AppUiInstallIcon => {
        const at = `ui.install.icons[${i}]`
        if (!isRecord(icon)) throw fail(`\`${at}\` must be an object.`)
        for (const key of Object.keys(icon)) {
          if (!ICON_KEYS.has(key)) throw fail(`\`${at}.${key}\` is not a supported field.`)
        }
        const path = icon.path
        if (typeof path !== "string" || !isSafeRelativeIconPath(path) || !ICON_EXT_RE.test(path)) {
          throw fail(`\`${at}.path\` must be a relative path, with no '..' segment, ending in .png, .svg or .webp.`)
        }
        if (icon.sizes !== undefined && (typeof icon.sizes !== "string" || !SIZES_RE.test(icon.sizes))) {
          throw fail(`\`${at}.sizes\` must be "any" or space-separated <w>x<h> pairs.`)
        }
        if (icon.purpose !== undefined && !(UI_INSTALL_PURPOSES as readonly unknown[]).includes(icon.purpose)) {
          throw fail(`\`${at}.purpose\` must be one of ${UI_INSTALL_PURPOSES.join(", ")}.`)
        }
        return Object.freeze({
          path,
          ...(icon.sizes !== undefined ? { sizes: icon.sizes as string } : {}),
          ...(icon.purpose !== undefined ? { purpose: icon.purpose as AppUiInstallIcon["purpose"] } : {}),
        })
      }),
    )
  }
  return Object.freeze(out)
}
