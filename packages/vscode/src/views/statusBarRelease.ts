/**
 * Status-bar item (WP-B) sitting next to the daemon health block (priority 48,
 * one below statusBar.ts's 49, adjoined on the left): a release indicator that
 * says when a newer `@agentproto/cli` (and therefore daemon) is available.
 *
 * Hides itself when the daemon is unreachable (the health probe throws), which
 * mirrors how the health block hides. Everything display-related lives in
 * statusBarRelease.logic.ts (no vscode import, unit-testable); this file only
 * drives the probe, the cache-backed npm check, and the paint.
 *
 * Refresh: on store.onDidChange and on the same repaint timer the sessions
 * tree uses (TREE_REPAINT_INTERVAL_MS). The npm poll itself is TTL-gated in
 * releaseCheck.ts (default ~1 h, min 10 min) — a repaint reads the cache and
 * only hits npm when stale.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import { getReleaseCheckIntervalMs } from "../config.js"
import type { SessionStore } from "../services/sessionStore.js"
import { releaseTtlMs, type ReleaseBuildSource } from "../services/releaseCheck.logic.js"
import type { ReleaseCheckView } from "../services/releaseCheck.js"
import { runReleaseCheck } from "../services/releaseCheck.js"
import { TREE_REPAINT_INTERVAL_MS } from "./sessionsTree.logic.js"
import {
  buildReleaseBarText,
  buildReleaseBarTooltip,
  releaseBarIcon,
  type ReleaseBarInput,
} from "./statusBarRelease.logic.js"

/** The extension's own Marketplace id (package.json publisher + name). */
const EXTENSION_ID = "agentproto.agentproto-vscode"

const STATUS_BAR_PRIORITY = 48

export function registerReleaseStatusBar(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    STATUS_BAR_PRIORITY,
  )
  item.command = "agentproto.showHealth"
  item.tooltip = "agentproto: release check — click for daemon health"

  const extensionVersion = (): string | null => {
    try {
      const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.version
      return typeof pkg === "string" && pkg.length > 0 ? pkg : null
    } catch {
      return null
    }
  }

  // Loop guard so a slow/offline npm fetch can't stack up on the timer.
  let inFlight = false
  let lastView: ReleaseCheckView | undefined

  const paint = (view: ReleaseCheckView, build: ReleaseBarInput["build"]): void => {
    lastView = view
    const editable: ReleaseBarInput = {
      state: view.state,
      localVersion: view.localVersion,
      latest: view.latest,
      extensionVersion: extensionVersion(),
      build,
    }
    const icon = releaseBarIcon(editable.state)
    const text = icon ? buildReleaseBarText(editable) : null
    if (!icon || !text) {
      item.hide()
      return
    }
    item.text = `$(${icon}) ${text}`
    item.tooltip = buildReleaseBarTooltip(editable)
    item.show()
  }

  const refresh = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      const health = await client.health()
      const localVersion =
        typeof health.version === "string" && health.version.length > 0 ? health.version : null
      const build = health.build ?? null
      const buildSource = normalizeBuildSource(build?.source)
      const view = await runReleaseCheck({
        localVersion,
        buildSource,
        ttlMs: releaseTtlMs(getReleaseCheckIntervalMs()),
      })
      paint(view, build)
    } catch {
      // Daemon unreachable — hide the indicator, like the health block.
      item.hide()
    } finally {
      inFlight = false
    }
  }

  const timer = setInterval(() => void refresh(), TREE_REPAINT_INTERVAL_MS)

  ctx.subscriptions.push(item)
  ctx.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)))
  ctx.subscriptions.push(store.onDidChange(() => void refresh()))
  void refresh()
}

/** `health.build.source` → the comparison's build source, null → tarball. */
function normalizeBuildSource(source: string | undefined): ReleaseBuildSource {
  return source === "workspace" ? "workspace" : "tarball"
}