/**
 * agentproto VS Code extension — activation entrypoint.
 *
 * Wires config → DaemonClient → SessionStore, then the views (sessions tree,
 * permissions inbox, status bar) and commands (spawn / prompt / interrupt /
 * kill / permissions / transcript). `agentproto.openTranscript` opens the
 * webview chat panel; `agentproto.openTranscriptChannel` is the raw
 * output-channel variant.
 */

import * as vscode from "vscode"

import { createDaemonClient, type DaemonClient } from "./client/daemonClient.js"
import { registerPermissionCommands } from "./commands/permissions.js"
import {
  registerSessionActions,
  resolveSessionArg,
} from "./commands/sessionActions.js"
import { registerSessionFilter } from "./commands/sessionFilter.js"
import { registerSessionRestart } from "./commands/sessionRestart.js"
import { registerSpawnCommand } from "./commands/spawn.js"
import { registerTranscript } from "./commands/transcript.js"
import { getConfig, onDidChangeConfig } from "./config.js"
import { SessionStore } from "./services/sessionStore.js"
import { registerPermissionsView } from "./views/permissionsTree.js"
import { registerSessionsView } from "./views/sessionsTree.js"
import { registerStatusBar } from "./views/statusBar.js"
import { registerTranscriptPanels } from "./webview/transcriptPanel.js"

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const config = getConfig()
  const client = createDaemonClient(config)
  const store = new SessionStore(client, config.pollIntervalMs)

  // Connection settings are bound at activation; every consumer holds this
  // client instance by value, so a config change requires a window reload.
  // (WP5 may thread a live getter through instead.)
  ctx.subscriptions.push(
    onDidChangeConfig(() => {
      void vscode.window.showInformationMessage(
        "agentproto: connection settings changed — reload the window to apply.",
      )
    }),
  )

  // Views. The filter controller owns the tree's filter/search state (and the
  // cached GET /workspaces join) and must exist before the sessions view, which
  // renders through it.
  const filter = registerSessionFilter(ctx, client, store)
  ctx.subscriptions.push(filter)
  registerSessionsView(ctx, store, filter)
  registerPermissionsView(ctx, store)
  registerStatusBar(ctx, store)

  // Start the live-update loop.
  store.start()
  ctx.subscriptions.push(store)

  // ── Commands ────────────────────────────────────────────────────────
  registerSpawnCommand(ctx, client, store)
  registerSessionActions(ctx, client, store)
  registerTranscript(ctx, client, store) // agentproto.openTranscriptChannel (raw log)
  registerPermissionCommands(ctx, client, store)
  registerSessionRestart(ctx, client, store) // agentproto.restartSession

  const transcriptPanels = registerTranscriptPanels(ctx, client, store)
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.showHealth", () =>
      showHealth(client),
    ),
    vscode.commands.registerCommand("agentproto.refresh", () =>
      store.refreshAll(),
    ),
    vscode.commands.registerCommand(
      "agentproto.openTranscript",
      async (arg: unknown) => {
        const session = await resolveSessionArg(
          arg,
          store,
          "Select a session to open transcript",
          () => true,
        )
        if (session) transcriptPanels.open(session)
      },
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

export function deactivate(): void {
  // Store + subscriptions are disposed via ctx.subscriptions.
}
