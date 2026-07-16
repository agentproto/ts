/**
 * agentproto.spawnAgent — one quick-pick flattening adapter+model into
 * "slug · model" rows. The default cwd (active editor's folder → sole
 * folder → ambiguous folder pick → none, see resolveDefaultCwd) and its
 * matching daemon workspace slug are resolved up front and shown in the
 * picker's placeHolder, then sent explicitly on spawn rather than left to
 * the daemon's own inference — autodetection must be visible, never silent.
 * A trailing "$(gear) Configure…" row opens the full adapter → model → mode
 * → cwd → label → prompt chain, unchanged, for anyone overriding a default.
 * Escape at any step aborts the whole wizard; an empty input box in the
 * Configure chain means "use the adapter default" and continues.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { WorkspacesConfig } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"
import { EMPTY_WORKSPACES } from "../services/workspaces.logic.js"
import {
  assembleSpawnOptions,
  buildSpawnPlaceHolder,
  CUSTOM_MODEL_LABEL,
  mapAdapterQuickPickItems,
  mapFolderQuickPickItems,
  mapModeQuickPickItems,
  mapModelQuickPickItems,
  mapOrchestratorQuickPickItems,
  mapPermissionQuickPickItems,
  mapSpawnQuickPickItems,
  resolveDefaultCwd,
  resolveWorkspaceSlug,
  type SpawnAdapterInfo,
  type SpawnWizardAnswers,
} from "./spawn.logic.js"

/**
 * Whether new sessions park their tool-permission requests for a human.
 * Read fresh on every spawn rather than cached: it's a setting the user
 * flips between spawns, and the collapsed picker has no other way to hear
 * about it.
 */
function holdPermissionsSetting(): boolean {
  return vscode.workspace.getConfiguration("agentproto").get<boolean>("holdPermissions", false)
}

export function registerSpawnCommand(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.spawnAgent", () => runSpawnWizard(client, store)),
  )
}

async function runSpawnWizard(client: DaemonClient, store: SessionStore): Promise<void> {
  let adapters: SpawnAdapterInfo[]
  try {
    adapters = (await client.listAdapters()) as SpawnAdapterInfo[]
  } catch (err) {
    vscode.window.showErrorMessage(`agentproto: could not list adapters — ${describeError(err)}`)
    return
  }
  if (adapters.length === 0) {
    vscode.window.showWarningMessage("agentproto: no adapters installed on the daemon.")
    return
  }

  const cwdResolution = await resolveWizardDefaultCwd()
  if (cwdResolution === undefined) return // Escape during folder disambiguation aborts the wizard.
  const defaultCwd = cwdResolution

  let workspaceConfig: WorkspacesConfig
  try {
    workspaceConfig = await client.listWorkspaces()
  } catch {
    // Old daemon with no /workspaces route, or unreachable — degrade to no
    // slug rather than block the spawn; the daemon infers as it does today.
    workspaceConfig = EMPTY_WORKSPACES
  }

  const holdDefault = holdPermissionsSetting()
  const picked = await vscode.window.showQuickPick(mapSpawnQuickPickItems(adapters), {
    placeHolder: buildSpawnPlaceHolder(workspaceConfig, defaultCwd, holdDefault),
  })
  if (!picked) return

  let answers: SpawnWizardAnswers
  if (picked.configure) {
    const configured = await runConfigureWizard(adapters, defaultCwd, holdDefault)
    if (!configured) return
    answers = configured
  } else if (picked.adapter) {
    answers = { adapter: picked.adapter.slug, permissionHold: holdDefault }
    if (picked.custom) {
      const custom = await vscode.window.showInputBox({
        prompt: "Custom model id (leave empty for adapter default)",
      })
      if (custom === undefined) return
      if (custom) answers.model = custom
    } else if (picked.model) {
      answers.model = picked.model
    }
    if (defaultCwd) answers.cwd = defaultCwd
  } else {
    return
  }

  const slug = resolveWorkspaceSlug(workspaceConfig, answers.cwd)
  if (slug) answers.workspaceSlug = slug

  // Show the row before asking, not after being answered: spawnAgent() blocks
  // while the daemon boots an adapter and finishes an ACP handshake, and until
  // it returns there is nothing to put in the tree — the daemon has no "session
  // started" event to announce the session either. So the operator clicked, the
  // list didn't move, and nothing said the request had even been heard.
  const pendingId = store.addPending({
    label: answers.label,
    adapterSlug: answers.adapter,
    model: answers.model,
    cwd: answers.cwd,
    workspaceSlug: answers.workspaceSlug,
  })
  await vscode.commands.executeCommand("agentproto.sessions.focus")
  try {
    const session = await client.spawnAgent(assembleSpawnOptions(answers))
    void vscode.window
      .showInformationMessage(`agentproto: spawned ${session.label ?? session.id}`, "Open transcript")
      .then(choice => {
        if (choice === "Open transcript") {
          void vscode.commands.executeCommand("agentproto.openTranscript", session.id)
        }
      })
    await store.refreshAll()
  } catch (err) {
    vscode.window.showErrorMessage(`agentproto: spawn failed — ${describeError(err)}`)
  } finally {
    // In `finally` so a failed spawn can't strand a row that will never
    // resolve. On the success path refreshAll() has already put the real
    // descriptor in the tree, so this swap doesn't flicker.
    store.resolvePending(pendingId)
  }
}

/**
 * Runs the cwd ladder against the live editor/workspace state. Returns the
 * resolved cwd (possibly undefined when no folder is open), or `undefined`
 * to signal the whole wizard was aborted (Escape during folder
 * disambiguation) — distinguished from a resolved-but-empty cwd by the
 * caller checking `=== undefined`.
 */
async function resolveWizardDefaultCwd(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? []
  const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath
  const resolution = resolveDefaultCwd({ folders, activeFilePath })
  if (resolution.kind === "resolved") return resolution.cwd
  if (resolution.kind === "none") return ""
  const picked = await vscode.window.showQuickPick(mapFolderQuickPickItems(resolution.candidates), {
    placeHolder: "Multiple workspace folders open — select one for the new session",
  })
  return picked?.folder.uri.fsPath
}

/** The full chain: adapter → model → mode → orchestrator → permissions → cwd → label → prompt, reached only via the Configure… row. */
async function runConfigureWizard(
  adapters: SpawnAdapterInfo[],
  defaultCwd: string,
  holdDefault: boolean,
): Promise<SpawnWizardAnswers | undefined> {
  const adapterPick = await vscode.window.showQuickPick(mapAdapterQuickPickItems(adapters), {
    placeHolder: "Select an agent adapter to spawn",
  })
  if (!adapterPick) return undefined

  const answers: SpawnWizardAnswers = { adapter: adapterPick.adapter.slug }

  const modelPick = await vscode.window.showQuickPick(
    mapModelQuickPickItems(adapterPick.adapter.models ?? []),
    { placeHolder: "Select a model (Escape for adapter default)" },
  )
  if (!modelPick) return undefined
  if (modelPick.custom) {
    const custom = await vscode.window.showInputBox({
      prompt: "Custom model id (leave empty for adapter default)",
    })
    if (custom === undefined) return undefined
    if (custom) answers.model = custom
  } else if (modelPick.label !== CUSTOM_MODEL_LABEL) {
    answers.model = modelPick.label
  }

  const modeItems = mapModeQuickPickItems(adapterPick.adapter.modes)
  if (modeItems.length > 0) {
    const modePick = await vscode.window.showQuickPick(modeItems, { placeHolder: "Select a mode" })
    if (!modePick) return undefined
    answers.mode = modePick.mode
  }

  // Asked before permissions: this decides what the session IS (does it
  // supervise others?), while permissions decide how it's governed.
  const orchestratorPick = await vscode.window.showQuickPick(mapOrchestratorQuickPickItems(), {
    placeHolder: "Will this session spawn subagents?",
  })
  if (!orchestratorPick) return undefined
  answers.orchestrator = orchestratorPick.orchestrator

  const permissionPick = await vscode.window.showQuickPick(
    mapPermissionQuickPickItems(holdDefault),
    { placeHolder: "Tool permissions" },
  )
  if (!permissionPick) return undefined
  answers.permissionHold = permissionPick.hold

  const cwd = await vscode.window.showInputBox({ prompt: "Working directory", value: defaultCwd })
  if (cwd === undefined) return undefined
  if (cwd) answers.cwd = cwd

  const label = await vscode.window.showInputBox({ prompt: "Session label (optional)" })
  if (label === undefined) return undefined
  if (label) answers.label = label

  const prompt = await vscode.window.showInputBox({ prompt: "Initial prompt (optional)" })
  if (prompt === undefined) return undefined
  if (prompt) answers.prompt = prompt

  return answers
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
