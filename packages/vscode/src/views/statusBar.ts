/**
 * Status bar item (WP1): one line summarising what the daemon's live sessions
 * are DOING, and what they have cost. Click runs `agentproto.showHealth`.
 *
 * The counting and the wording live in statusBar.logic.ts (no vscode import,
 * so the one line that is on screen permanently is unit-testable); this file
 * only paints it.
 *
 * Repaints on store.onDidChange AND on a timer. Everything here is computed
 * against `now` — a stall is the ABSENCE of events — so a change-driven
 * repaint alone can never notice a session going quiet (same reasoning, and
 * the same interval, as the sessions tree).
 *
 * Hides itself when there's nothing cached AND the live-update loop is
 * unhealthy (daemon unreachable) — the store has no explicit lastError, so
 * `healthy` (session_events_poll loop state) plus an empty session list is the
 * best available "unreachable" signal.
 */

import * as vscode from "vscode"

import type { SessionStore } from "../services/sessionStore.js"
import { TREE_REPAINT_INTERVAL_MS } from "./sessionsTree.logic.js"
import {
  buildStatusText,
  statusBarIcon,
  summarizeLive,
  type LiveSummary,
} from "./statusBar.logic.js"

const STATUS_BAR_PRIORITY = 49

function buildTooltip(summary: LiveSummary): vscode.MarkdownString {
  const md = new vscode.MarkdownString()
  md.appendMarkdown(`**agentproto** — ${buildStatusText(summary).replace(/^agentproto: /, "")}\n\n`)
  if (summary.live.length === 0) {
    md.appendMarkdown("_No live sessions._")
  } else {
    md.appendMarkdown(summary.live.map(s => `- ${s.label ?? s.command}`).join("\n"))
  }
  // Machine-origin sessions (gate reviewers, …) are excluded from the counts
  // above but must still be visible SOMEWHERE — this is that somewhere.
  if (summary.machineLive.length > 0) {
    md.appendMarkdown("\n\n_Automated (not counted above):_\n\n")
    md.appendMarkdown(summary.machineLive.map(s => `- ${s.label ?? s.command}`).join("\n"))
  }
  md.appendMarkdown("\n\nClick to check daemon health.")
  return md
}

export function registerStatusBar(ctx: vscode.ExtensionContext, store: SessionStore): void {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    STATUS_BAR_PRIORITY,
  )
  item.command = "agentproto.showHealth"

  const update = (): void => {
    const sessions = store.sessions
    if (sessions.length === 0 && !store.healthy) {
      item.hide()
      return
    }
    const summary = summarizeLive(sessions, Date.now())
    item.text = `$(${statusBarIcon(summary)}) ${buildStatusText(summary)}`
    item.tooltip = buildTooltip(summary)
    item.show()
  }

  const timer = setInterval(update, TREE_REPAINT_INTERVAL_MS)

  ctx.subscriptions.push(item)
  ctx.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)))
  ctx.subscriptions.push(store.onDidChange(update))
  update()
}
