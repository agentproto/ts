import { accessSync, constants, existsSync } from "node:fs"
import { homedir, platform as osPlatform } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"

export interface ResolveChromeInput {
  env?: Record<string, string | undefined>
  platform?: string
  home?: string
  /** Test seam: whether a path is an existing file. */
  exists?: (path: string) => boolean
}

export const CHROME_ENV_VAR = "CHROME_EXECUTABLE_PATH"

const MAC_APPS = [
  ["Google Chrome.app", "Google Chrome"],
  ["Google Chrome Beta.app", "Google Chrome Beta"],
  ["Google Chrome Canary.app", "Google Chrome Canary"],
  ["Chromium.app", "Chromium"],
  ["Microsoft Edge.app", "Microsoft Edge"],
  ["Brave Browser.app", "Brave Browser"],
] as const

const LINUX_NAMES = ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium", "microsoft-edge", "brave-browser"]
const LINUX_ABSOLUTE = ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"]

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return existsSync(path)
  } catch {
    return false
  }
}

/** Every place a system Chrome may live on this OS, best first. */
export function chromeCandidates(input: ResolveChromeInput = {}): string[] {
  const env = input.env ?? process.env
  const platform = input.platform ?? osPlatform()
  const home = input.home ?? homedir()
  if (platform === "darwin") {
    return MAC_APPS.flatMap(([app, bin]) => [
      join("/Applications", app, "Contents", "MacOS", bin),
      join(home, "Applications", app, "Contents", "MacOS", bin),
    ])
  }
  if (platform === "win32") {
    const roots = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]].filter((r): r is string => Boolean(r))
    return roots.flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ])
  }
  const onPath = (env["PATH"] ?? "").split(delimiter).filter(Boolean).flatMap((dir) => LINUX_NAMES.map((name) => join(dir, name)))
  return [...LINUX_ABSOLUTE, ...onPath]
}

/**
 * Find a system Chrome: `CHROME_EXECUTABLE_PATH` (an explicit override that must exist),
 * then the standard per-OS install paths. Returns `undefined` when none is found.
 */
export function resolveChrome(input: ResolveChromeInput = {}): string | undefined {
  const env = input.env ?? process.env
  const exists = input.exists ?? isExecutableFile
  const override = env[CHROME_ENV_VAR]
  if (override) {
    if (!isAbsolute(override) || !exists(override)) {
      throw new Error(`[chrome] ${CHROME_ENV_VAR} is set to "${override}" but that is not an existing absolute file path`)
    }
    return override
  }
  return chromeCandidates(input).find((candidate) => exists(candidate))
}
