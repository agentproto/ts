/**
 * Where a running `agentproto` actually lives, and which Node it belongs to.
 *
 * `daemon install` captures `[process.execPath, process.argv[1]]` into the
 * launchd plist / Windows task launcher — the Node binary and the CLI entry of
 * the invocation. When that invocation is a workspace/monorepo checkout
 * (`node packages/cli/dist/cli.mjs`, a `pnpm`/`node_modules/.bin` shim, …) the
 * entry is the LOCAL folder, so the daemon service silently runs a local build
 * instead of the npm-installed CLI. This module is the one place that names
 * that distinction, shared by `serve.ts`'s `/health` `build.source`, the
 * doctor/onboarding preflight step, and `daemon install`'s captured-service
 * report — so all of them agree on what "published" vs "workspace" means.
 */

import { posix as pathPosix, win32 as pathWin32 } from "node:path"

/** An `npm i -g` install (under a `node_modules`/`.npm` tree) vs a local
 *  workspace/dev checkout vs something we can't tell. */
export type CliInstallSource = "published" | "workspace" | "unknown"

/**
 * Classify a CLI entry path. A published npm install lives under
 * `…/node_modules/@agentproto/cli/…` or the npx cache (`…/.npm/_npx/…`);
 * anything else is a workspace/local build. Mirrors `serve.ts`'s
 * `build.source` so `agentproto daemon status` and `agentproto doctor` agree.
 */
export function cliInstallSource(entry: string | null | undefined): CliInstallSource {
  if (!entry) return "unknown"
  return entry.includes("/node_modules/") || entry.includes("/.npm/") ? "published" : "workspace"
}

/** Which Node a binary belongs to — enough to tell the user "nvm vs system". */
export type NodeInstallKind = "nvm" | "fnm" | "volta" | "homebrew" | "system"

export interface NodeInstallInfo {
  kind: NodeInstallKind
  /** The Node prefix: POSIX `<prefix>/bin/node` → `<prefix>`,
   *  win32 `<prefix>\node.exe` → `<prefix>`. */
  prefix: string
}

/**
 * Human-readable label + global prefix for the Node install a binary belongs
 * to, so `daemon install` can say WHICH global prefix it is about to make the
 * daemon run under (the user can veto before it clobbers the wrong one).
 * Selects the path dialect from `platform` (not the host) so it is testable
 * for win32 on macOS, like `globalNodeModulesDir`.
 */
export function describeNodeInstall(
  nodeExecPath: string,
  platform: NodeJS.Platform = process.platform,
): NodeInstallInfo {
  const path = platform === "win32" ? pathWin32 : pathPosix
  const binDir = path.dirname(nodeExecPath)
  const prefix = platform === "win32" ? binDir : path.dirname(binDir)
  const norm = nodeExecPath.split("\\").join("/")
  const kind: NodeInstallKind = /\/\.?nvm\//.test(norm)
    ? "nvm"
    : /\/\.?fnm\//.test(norm)
      ? "fnm"
      : /\/\.?volta\//.test(norm)
        ? "volta"
        : /\/opt\/homebrew\/|\/homebrew\//.test(norm)
          ? "homebrew"
          : "system"
  return { kind, prefix }
}

/**
 * The `[node, entry]` a service was just installed to run, one line each, plus
 * a loud warning when the entry is a workspace/local build. Returned (not
 * printed) so `daemon install` and its tests can both use it.
 */
export function renderServiceTarget(
  nodeExecPath: string,
  entry: string | null,
  platform: NodeJS.Platform = process.platform,
): string {
  const source = cliInstallSource(entry)
  const { kind, prefix } = describeNodeInstall(nodeExecPath, platform)
  const label =
    source === "workspace"
      ? "workspace build (LOCAL FOLDER — not the npm install)"
      : source === "published"
        ? "published npm install"
        : "unknown"
  const lines = [
    `  node:    ${nodeExecPath}  (${kind}, global prefix ${prefix})`,
    `  entry:   ${entry ?? "?"}`,
    `  source:  ${label}`,
  ]
  if (source === "workspace") {
    lines.push(
      `  ! this is a workspace/dev checkout, not the npm-installed CLI — the service`,
      `    will run that local folder. To run the published CLI instead:`,
      `      npm i -g @agentproto/cli@latest   (then re-run: agentproto daemon install)`,
    )
  }
  return lines.join("\n") + "\n"
}
