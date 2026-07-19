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
import { registerCreateWorkspaceCommand } from "./commands/createWorkspace.js"
import { registerPermissionCommands } from "./commands/permissions.js"
import {
  registerSessionActions,
  resolveSessionArg,
} from "./commands/sessionActions.js"
import { registerSessionArchive } from "./commands/sessionArchive.js"
import { registerSessionFilter } from "./commands/sessionFilter.js"
import { registerSessionRestart } from "./commands/sessionRestart.js"
import { registerImportConversationCommand } from "./commands/importConversation.js"
import { registerSwitchHarness } from "./commands/switchHarness.js"
import { registerSpawnCommand } from "./commands/spawn.js"
import { registerTranscript } from "./commands/transcript.js"
import { getConfig, onDidChangeConfig } from "./config.js"
import { SeenTracker } from "./services/seen.js"
import { SessionStore } from "./services/sessionStore.js"
import { registerPermissionsView } from "./views/permissionsTree.js"
import { registerSessionsView } from "./views/sessionsTree.js"
import { registerStatusBar } from "./views/statusBar.js"
import { registerTerminalSwitch } from "./terminal/terminalSwitch.js"
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
  // Read-receipts are per workspace and survive a reload: which sessions you
  // have looked at is a property of your working context, not of the daemon.
  const seen = new SeenTracker(ctx.workspaceState)
  ctx.subscriptions.push(seen)
  registerSessionsView(ctx, store, filter, seen)
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
  registerSessionArchive(ctx, client, store) // agentproto.archiveSession / unarchiveSession
  registerImportConversationCommand(ctx, client, store) // agentproto.importConversation
  registerCreateWorkspaceCommand(ctx, client, filter) // agentproto.createWorkspace

  const transcriptPanels = registerTranscriptPanels(ctx, client, store, seen)
  registerTerminalSwitch(ctx, client, store, () => transcriptPanels.activeSessionId())
  registerSwitchHarness(ctx, client, store, () => transcriptPanels.activeSessionId())
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.showHealth", () =>
      showHealth(client),
    ),
    vscode.commands.registerCommand("agentproto.refresh", () =>
      store.refreshAll(),
    ),
    // Simple toggle, not full filter-infra integration (SessionFilterState's
    // shape is frozen — see sessionFilter.logic.ts) — flips the store's
    // archived-visibility flag, which re-fetches from the daemon with
    // `includeArchived` and repaints the tree with the newly-visible
    // (dimmed, $(archive)-iconed) rows.
    vscode.commands.registerCommand("agentproto.toggleShowArchived", () => {
      store.setShowArchived(!store.showArchived)
      vscode.window.setStatusBarMessage(
        `agentproto: archived sessions ${store.showArchived ? "shown" : "hidden"}`,
        3000,
      )
    }),
    vscode.commands.registerCommand(
      "agentproto.openTranscript",
      async (arg: unknown) => {
        const session = await resolveSessionArg(
          arg,
          store,
          "Select a session to open transcript",
          () => true,
          client,
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
