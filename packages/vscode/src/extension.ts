/**
 * agentproto VS Code extension — activation entrypoint.
 *
 * Wires config → DaemonClient → SessionStore, then the views (sessions tree,
 * permissions inbox, harnesses, auth profiles, status bar) and commands
 * (spawn / prompt / interrupt / kill / permissions / transcript / harness /
 * auth profile). `agentproto.openTranscript` opens the webview chat panel;
 * `agentproto.openTranscriptChannel` is the raw output-channel variant.
 */

import * as vscode from "vscode"

import { createDaemonClient, type DaemonClient } from "./client/daemonClient.js"
import { registerAppCommands } from "./commands/apps.js"
import { registerHarnessCommands } from "./commands/harnesses.js"
import { registerAuthProfileCommands } from "./commands/authProfiles.js"
import { registerLocalRouterCommands } from "./commands/localRouter.js"
import { registerOnboardingCommand } from "./commands/onboarding.js"
import { maybeAutoAdoptLocalLogin } from "./commands/localLogin.js"
import { registerCreateWorkspaceCommand } from "./commands/createWorkspace.js"
import { registerPermissionCommands } from "./commands/permissions.js"
import {
  registerSessionActions,
  resolveSessionArg,
} from "./commands/sessionActions.js"
import { registerSessionArchive } from "./commands/sessionArchive.js"
import { registerSessionCleanup } from "./commands/sessionCleanup.js"
import { registerWorktreeCleanup } from "./commands/worktreeCleanup.js"
import { registerSessionRename } from "./commands/sessionRename.js"
import { registerSaveFavorite } from "./commands/saveFavorite.js"
import { registerSessionFilter } from "./commands/sessionFilter.js"
import { registerSessionRestart } from "./commands/sessionRestart.js"
import { registerSessionResume } from "./commands/sessionResume.js"
import { registerSessionAccessProfile } from "./commands/sessionAccessProfile.js"
import { registerImportConversationCommand } from "./commands/importConversation.js"
import { registerSelectWorkspaceCommand } from "./commands/selectWorkspace.js"
import { registerSwitchHarness } from "./commands/switchHarness.js"
import { registerSessionConfig } from "./commands/sessionConfig.js"
import { registerSessionContinuityCommands } from "./commands/sessionContinuity.js"
import { registerDaemonConfig } from "./commands/daemonConfig.js"
import { registerSpawnCommand } from "./commands/spawn.js"
import { registerTranscript } from "./commands/transcript.js"
import { registerWatchSessionCommands } from "./commands/watchSession.js"
import { getConfig, onDidChangeConfig } from "./config.js"
import { SeenTracker } from "./services/seen.js"
import { SessionStore } from "./services/sessionStore.js"
import { WatchedSessions } from "./services/watchedSessions.js"
import { WorkspacePinStore } from "./services/workspacePin.js"
import { registerAppsView } from "./views/appsTree.js"
import { registerPermissionsView } from "./views/permissionsTree.js"
import { registerSessionsView } from "./views/sessionsTree.js"
import { registerHarnessesView } from "./views/harnessesTree.js"
import { registerAuthProfilesView } from "./views/authProfilesTree.js"
import { registerAuthSettingsPanel } from "./webview/authSettingsPanel.js"
import { registerStatusBar } from "./views/statusBar.js"
import { registerHarnessesWebview } from "./webview/harnessesWebviewPanel.js"
import { registerAuthProfilesWebview } from "./webview/authProfilesWebviewPanel.js"
import { registerWorkspacePinStatusBar } from "./views/workspacePinStatusBar.js"
import { registerTerminalSwitch } from "./terminal/terminalSwitch.js"
import { registerTranscriptPanels } from "./webview/transcriptPanel.js"
import { registerSessionsWebview } from "./webview/sessionsWebviewPanel.js"
import { registerAppPanels } from "./webview/appPanel.js"
import { registerStoryPanels } from "./webview/storyPanel.js"
import { registerConfigurationLabWebview } from "./webview/configurationLabPanel.js"
import { registerAuthModelMindmap, type AuthModelFocusTarget } from "./webview/authModelMindmapPanel.js"
import { registerAuthExplorer } from "./webview/authExplorerPanel.js"

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
  // Watched sessions — same per-workspace persistence: which sessions you
  // pinned an eye on is a property of your working context. attach() raises
  // the transition toasts off the store's onDidChange.
  const watched = new WatchedSessions(ctx.workspaceState)
  ctx.subscriptions.push(watched, watched.attach(store))
  registerSessionsView(ctx, store, filter, seen, watched)
  registerPermissionsView(ctx, store)
  const harnessesProvider = registerHarnessesView(ctx, client)
  const authProfilesProvider = registerAuthProfilesView(ctx, client)
  const appsProvider = registerAppsView(ctx, client)
  registerStatusBar(ctx, store)

  // Per-window "target workspace" pin — client-side only, never the daemon's
  // global `active` workspace. See services/workspacePin.ts.
  const workspacePin = new WorkspacePinStore(ctx.workspaceState)
  ctx.subscriptions.push(workspacePin)
  registerSelectWorkspaceCommand(ctx, client, workspacePin)
  registerWorkspacePinStatusBar(ctx, client, workspacePin)

  // Start the live-update loop.
  store.start()
  ctx.subscriptions.push(store)

  // ── Commands ────────────────────────────────────────────────────────
  registerSpawnCommand(ctx, client, store, workspacePin)
  registerSessionActions(ctx, client, store)
  registerTranscript(ctx, client, store) // agentproto.openTranscriptChannel (raw log)
  registerPermissionCommands(ctx, client, store)
  registerSessionRestart(ctx, client, store) // agentproto.restartSession (new id)
  registerSessionResume(ctx, client, store) // agentproto.resumeSession (in place, same id)
  registerSessionAccessProfile(ctx, client, store, authProfilesProvider) // agentproto.setSessionAccessProfile
  registerSessionArchive(ctx, client, store) // agentproto.archiveSession / unarchiveSession
  registerSessionCleanup(ctx, client, store) // agentproto.cleanEndedSessions
  registerWorktreeCleanup(ctx, client) // agentproto.cleanWorktrees
  registerSessionRename(ctx, client, store) // agentproto.renameSession
  registerSaveFavorite(ctx, client, store) // agentproto.saveFavorite
  registerWatchSessionCommands(ctx, store, watched) // agentproto.watchSession / unwatchSession
  registerImportConversationCommand(ctx, client, store) // agentproto.importConversation
  registerCreateWorkspaceCommand(ctx, client, filter) // agentproto.createWorkspace
  registerHarnessCommands(ctx, client, harnessesProvider)
  registerAuthProfileCommands(ctx, client, authProfilesProvider)
  registerLocalRouterCommands(ctx, client, authProfilesProvider) // agentproto.start/stopLlmEndpoint
  registerOnboardingCommand(ctx, client, authProfilesProvider) // agentproto.runOnboarding
  registerAuthSettingsPanel(ctx) // agentproto.openAuthSettings — redirector to Wallets / Auth & Model Map

  // One-time auto-adopt of a local Claude Code login (agentproto.autoAdoptLocalLogin).
  // Fire-and-forget: it never throws into activation and self-gates on the setting.
  void maybeAutoAdoptLocalLogin(ctx, client, authProfilesProvider)

  const transcriptPanels = registerTranscriptPanels(ctx, client, store, seen)
  // Opt-in alternative to the Sessions tree (agentproto.sessionsView === "webview",
  // package.json's `when` clauses make the two mutually exclusive in the
  // sidebar). Uses its own lightweight summary endpoint for progressive loading
  // while sharing the store's live-update signal and the transcriptPanels path.
  registerSessionsWebview(ctx, client, store, filter, transcriptPanels, seen, watched)
  // Opt-in webview alternatives for Harnesses and Auth Profiles, gated by
  // `agentproto.harnessesView` / `agentproto.authProfilesView` in package.json.
  registerHarnessesWebview(ctx, client, harnessesProvider)
  registerAuthProfilesWebview(ctx, client, authProfilesProvider)
  registerConfigurationLabWebview(ctx, client)
  const storyPanels = registerStoryPanels(ctx, client) // agentproto.openStory (live session-story overlay)
  const appPanels = registerAppPanels(ctx, client) // agentproto.openAppPanel (installed app UI panels)
  registerAppCommands(ctx, client, appPanels, appsProvider) // agentproto.openAppPanel / refreshApps
  const authModelMindmap = registerAuthModelMindmap(ctx, client) // agentproto.openAuthModel (auth/model config map)
  const authExplorer = registerAuthExplorer(ctx, client, authProfilesProvider) // agentproto.openAuthExplorer (editable auth & models)
  registerTerminalSwitch(ctx, client, store, () => transcriptPanels.activeSessionId())
  registerSwitchHarness(ctx, client, store, () => transcriptPanels.activeSessionId())
  registerSessionConfig(ctx, client, store, authProfilesProvider, () => transcriptPanels.activeSessionId()) // agentproto.configureSession
  registerSessionContinuityCommands(ctx, client, store, () => transcriptPanels.activeSessionId()) // agentproto.compactSession / agentproto.continueSessionFresh
  registerDaemonConfig(ctx, client) // agentproto.showDaemonConfig
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.showHealth", () =>
      showHealth(client),
    ),
    vscode.commands.registerCommand("agentproto.refresh", () =>
      store.refreshAll(),
    ),
    vscode.commands.registerCommand("agentproto.openConfigurationLab", () =>
      vscode.commands.executeCommand("agentproto.configurationLab.focus"),
    ),
    vscode.commands.registerCommand("agentproto.openAuthModel", (arg?: unknown) =>
      authModelMindmap.open(isAuthModelFocusTarget(arg) ? arg : undefined),
    ),
    vscode.commands.registerCommand("agentproto.openAuthExplorer", () =>
      authExplorer.open(),
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
    vscode.commands.registerCommand(
      "agentproto.openStory",
      async (arg: unknown) => {
        const session = await resolveSessionArg(
          arg,
          store,
          "Select a session to open its story",
          () => true,
          client,
        )
        if (session) storyPanels.open(session)
      },
    ),
  )
}

function isAuthModelFocusTarget(value: unknown): value is AuthModelFocusTarget {
  if (typeof value !== "object" || value === null) return false
  const v = value as { kind?: unknown; key?: unknown }
  return (v.kind === "harness" || v.kind === "provider") && typeof v.key === "string"
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
