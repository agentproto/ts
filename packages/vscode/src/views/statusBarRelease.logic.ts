/**
 * Pure release status-bar display logic — NO vscode import, so what is painted
 * next to the daemon block is unit-testable (same contract as statusBar.logic.ts).
 *
 * Decided states (WP-B from .plans/release-update-indicator-PLAN.md):
 *  - `current`  → discreet `$(check) vX`
 *  - `behind`   → `$(arrow-up) update vY dispo`
 *  - `workspace`→ the daemon runs from a workspace build — the meaningful
 *                 action is a local REBUILD, not an npm install, so we show the
 *                 local version plus a "rebuild" hint rather than a bare
 *                 "update available".
 *  - `unknown`  → nothing extra (do not claim an unverified update).
 *
 * Daemon-down hiding is the parent's job (the vsix/view hides when it cannot
 * reach the daemon, mirroring the health block); this module only maps a
 * decided state to display strings.
 */

import { compareVersions } from "../services/releaseCheck.logic.js"

export type ReleaseBarState = "current" | "behind" | "unknown" | "workspace"

export interface ReleaseBuildInfo {
  sha?: string
  builtAt?: string
  source?: string
}

/** Everything the tooltip / text can mention for a decided state. */
export interface ReleaseBarInput {
  state: ReleaseBarState
  /** Local CLI version (`health.version`). */
  localVersion: string | null
  /** Latest `@agentproto/cli` on npm, when known. */
  latest: string | null
  /** Extension's own version (`packageJSON.version`). */
  extensionVersion: string | null
  /** Daemon build identity (`health.build`). */
  build: ReleaseBuildInfo | null
}

/** Codicon id (no `$()`) for the decided state. See codicons. */
export function releaseBarIcon(state: ReleaseBarState): string | null {
  switch (state) {
    case "behind":
      return "arrow-up"
    case "workspace":
      return "tools"
    case "current":
      return "check"
    default:
      // unknown → nothing painted.
      return null
  }
}

/**
 * The status-bar text (icon excluded). Returns null when nothing should be
 * painted — `unknown` (an unverified update must not be claimed), and
 * `current` when we lack a local version to show.
 */
export function buildReleaseBarText(input: ReleaseBarInput): string | null {
  const { state, localVersion, latest } = input
  switch (state) {
    case "behind":
      if (!latest) return null
      return `update v${latest} dispo`
    case "workspace":
      return localVersion ? `v${localVersion} rebuild` : null
    case "current":
      return localVersion ? `v${localVersion}` : null
    default:
      return null
  }
}

/**
 * Markdown tooltip. Always informational — lists local vs latest vs build vs
 * extension version. For `behind`/`workspace` it frames what "update" means.
 */
export function buildReleaseBarTooltip(input: ReleaseBarInput): string {
  const { state, localVersion, latest, extensionVersion, build } = input
  const md: string[] = ["**agentproto — release check**"]
  if (localVersion) md.push(`Local CLI: **${localVersion}**`)
  if (state === "behind" && latest) {
    md.push(`A newer release is available: **v${latest}**`)
    md.push("Click for daemon health — update flows from there.")
  } else if (state === "workspace") {
    if (latest) md.push(`Latest published: **v${latest}**`)
    md.push("Running from a workspace build — update via `git pull` + rebuild.")
  } else if (latest && compareVersions(latest, localVersion ?? "") !== 0) {
    md.push(`Latest published: **v${latest}**`)
  }
  if (build) {
    const bits = [build.source, build.sha, build.builtAt ? `built ${build.builtAt}` : undefined]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
    if (bits.length > 0) md.push(`Daemon build: ${bits.join(" · ")}`)
  }
  if (extensionVersion) md.push(`Extension: v${extensionVersion}`)
  md.push("Click to check daemon health.")
  return md.join("\n\n")
}