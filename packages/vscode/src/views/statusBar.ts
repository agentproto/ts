/**
 * Status bar item (WP1): one item showing daemon-wide running/busy counts
 * and the total cost of live sessions. Click runs `agentproto.showHealth`.
 * Updates on store.onDidChange; hides itself when there's nothing cached
 * AND the live-update loop is unhealthy (daemon unreachable) — the store
 * has no explicit lastError, so `healthy` (session_events_poll loop state)
 * plus an empty session list is the best available "unreachable" signal.
 */

import * as vscode from "vscode"

import type { SessionDescriptor } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"

const STATUS_BAR_PRIORITY = 49

interface LiveSummary {
  runningCount: number
  busyCount: number
  costUsd: number
  live: SessionDescriptor[]
}

function summarizeLive(sessions: readonly SessionDescriptor[]): LiveSummary {
  const live = sessions.filter(s => s.status === "running" || s.status === "starting")
  const busyCount = live.filter(s => s.busy).length
  const costUsd = live.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
  return { runningCount: live.length, busyCount, costUsd, live }
}

function buildTooltip(summary: LiveSummary): vscode.MarkdownString {
  const md = new vscode.MarkdownString()
  md.appendMarkdown(
    `**agentproto** — ${summary.runningCount} running, ${summary.busyCount} busy\n\n`,
  )
  if (summary.live.length === 0) {
    md.appendMarkdown("_No live sessions._")
  } else {
    md.appendMarkdown(summary.live.map(s => `- ${s.label ?? s.command}`).join("\n"))
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
    const summary = summarizeLive(sessions)
    item.text = `$(pulse) agentproto: ${summary.runningCount} running ▸ ${summary.busyCount} busy · $${summary.costUsd.toFixed(2)}`
    item.tooltip = buildTooltip(summary)
    item.show()
  }

  ctx.subscriptions.push(item)
  ctx.subscriptions.push(store.onDidChange(update))
  update()
}
