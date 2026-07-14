/**
 * agentproto VS Code extension — activation entrypoint (WP0).
 *
 * Wires the frozen foundation: config → DaemonClient → SessionStore, then
 * registers every declared command (full contributes block was written in
 * WP0; WP1–4 implement the stubs). Only `agentproto.showHealth` does real
 * work here — every other command toasts "not implemented yet" so a user
 * clicking through the UI gets honest feedback instead of a silent no-op.
 *
 * A status-bar item shows the live session count, updated on store change.
 */

import * as vscode from "vscode"

import { createDaemonClient, type DaemonClient } from "./client/daemonClient.js"
import { getConfig, onDidChangeConfig } from "./config.js"
import { SessionStore } from "./services/sessionStore.js"
import { registerPermissionsView } from "./views/permissionsTree.js"
import { registerSessionsView } from "./views/sessionsTree.js"

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  let config = getConfig()
  let client = createDaemonClient(config)
  const store = new SessionStore(client, config.pollIntervalMs)

  // Live config: rebuild the client when connection settings change.
  ctx.subscriptions.push(
    onDidChangeConfig(next => {
      config = next
      client = createDaemonClient(config)
      // The store keeps the old client reference; for WP0 we accept that a
      // config change requires a reload to fully rebind. (WP5 may make the
      // store hot-swap its client.)
    }),
  )

  // Views (placeholder providers — WP1/WP3 replace only the view files).
  registerSessionsView(ctx, store)
  registerPermissionsView(ctx, store)

  // Status bar: live session count.
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50,
  )
  status.command = "agentproto.showHealth"
  status.tooltip = "agentproto — click to check daemon health"
  const updateStatus = (): void => {
    const n = store.sessions.length
    const running = store.sessions.filter(s => s.status === "running").length
    status.text = `$(debug-start) agentproto: ${running}/${n}`
    status.show()
  }
  ctx.subscriptions.push(status)
  ctx.subscriptions.push(store.onDidChange(updateStatus))
  updateStatus()

  // Start the live-update loop.
  store.start()
  ctx.subscriptions.push(store)

  // ── Commands ────────────────────────────────────────────────────────
  // `showHealth` is the one real command in WP0; the rest are stubs.
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.showHealth", () =>
      showHealth(client),
    ),
    vscode.commands.registerCommand("agentproto.refresh", () =>
      store.refreshAll(),
    ),
    vscode.commands.registerCommand("agentproto.spawnAgent", () =>
      stub("Spawn Agent"),
    ),
    vscode.commands.registerCommand("agentproto.promptSession", () =>
      stub("Prompt Session"),
    ),
    vscode.commands.registerCommand("agentproto.interruptSession", () =>
      stub("Interrupt Session"),
    ),
    vscode.commands.registerCommand("agentproto.killSession", () =>
      stub("Kill Session"),
    ),
    vscode.commands.registerCommand("agentproto.openTranscript", () =>
      stub("Open Transcript"),
    ),
    vscode.commands.registerCommand("agentproto.approvePermission", () =>
      stub("Approve Permission"),
    ),
    vscode.commands.registerCommand("agentproto.denyPermission", () =>
      stub("Deny Permission"),
    ),
  )
}

async function showHealth(client: DaemonClient): Promise<void> {
  try {
    const health = await client.health()
    const uptime =
      typeof health.uptimeMs === "number"
        ? `${Math.round(health.uptimeMs / 1000)}s`
        : "—"
    vscode.window.showInformationMessage(
      `agentproto daemon: ${health.status} · workspace ${health.workspace} · uptime ${uptime}`,
    )
  } catch (err) {
    vscode.window.showErrorMessage(
      `agentproto daemon unreachable: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function stub(label: string): void {
  void vscode.window.showInformationMessage(
    `agentproto: ${label} — not implemented yet (WP0 foundation).`,
  )
}

export function deactivate(): void {
  // Store + subscriptions are disposed via ctx.subscriptions.
}
