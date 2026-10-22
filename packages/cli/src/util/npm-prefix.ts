/**
 * npm global-prefix detection for the CLI's own install.
 *
 * When the CLI was installed with `npm i -g --prefix <dir>` — exactly what
 * `scripts/bootstrap/install.sh` does on a Linux box whose npm global prefix
 * is root-owned (#2056) — a later bare `npm i -g <pkg>` targets npm's DEFAULT
 * prefix, not `<dir>`. The adapter package then lands in a different tree
 * than the CLI, and `resolveAdapter` (which walks up from the CLI's own
 * location) cannot import it. That is the cold-start failure this helper
 * prevents: every global npm install the CLI performs is pinned to the
 * prefix the CLI itself lives under.
 *
 * Detection is deliberately conservative. A path only counts as a global
 * install when it matches npm's documented layouts:
 *   - POSIX:   <prefix>/lib/node_modules/@agentproto/cli/...
 *   - Windows: <prefix>/node_modules/@agentproto/cli/...
 * A repo-local install (`<repo>/node_modules/@agentproto/cli`) or a pnpm
 * virtual-store path returns undefined, so we never invent a `--prefix` that
 * would relocate a developer's dependencies.
 */

import { realpathSync } from "node:fs"
import { basename, dirname } from "node:path"

const PACKAGE_PATH = "@agentproto/cli/"

/**
 * Derive the npm global prefix from the CLI entry file's path, or undefined
 * when the entry is not a recognized global install of `@agentproto/cli`.
 */
export function npmGlobalPrefixFromEntry(
  entry: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const normalized = platform === "win32" ? entry.replace(/\\/g, "/") : entry
  const marker = "/node_modules/"
  const index = normalized.lastIndexOf(marker)
  if (index === -1) return undefined

  const after = normalized.slice(index + marker.length)
  if (!after.startsWith(PACKAGE_PATH)) return undefined

  const nodeModules = normalized.slice(0, index + "/node_modules".length)
  if (platform === "win32") {
    const prefix = nodeModules.slice(0, -"/node_modules".length)
    return prefix || undefined
  }

  // POSIX global layout only: <prefix>/lib/node_modules.
  if (basename(dirname(nodeModules)) !== "lib") return undefined
  return dirname(dirname(nodeModules))
}

/** The npm prefix this CLI was installed under. `process.argv[1]` may be a
 *  symlink (Homebrew, /usr/local/bin), so resolve it first when possible. */
export function npmGlobalPrefixForCli(
  entry: string | undefined = process.argv[1],
): string | undefined {
  if (!entry) return undefined
  let resolved = entry
  try {
    resolved = realpathSync(entry)
  } catch {
    // Entry may not exist in tests/synthetic calls — parse the given path.
  }
  return npmGlobalPrefixFromEntry(resolved)
}

/**
 * Pin a global npm invocation to the CLI's own prefix. Non-global commands
 * and commands that already carry `--prefix` are returned unchanged.
 */
export function withNpmGlobalPrefix(
  args: readonly string[],
  prefix: string | undefined = npmGlobalPrefixForCli(),
): string[] {
  if (!prefix) return [...args]
  const isGlobal = args.some(
    arg => arg === "-g" || arg === "--global" || arg === "--location=global",
  )
  const hasPrefix = args.some(
    arg => arg === "--prefix" || arg.startsWith("--prefix="),
  )
  if (!isGlobal || hasPrefix) return [...args]
  const [command, ...rest] = args
  if (!command || command.startsWith("-")) return [...args, "--prefix", prefix]
  return [command, "--prefix", prefix, ...rest]
}
