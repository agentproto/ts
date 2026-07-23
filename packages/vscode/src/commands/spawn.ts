/**
 * agentproto.spawnAgent — one quick-pick grouping every adapter's declared
 * models under a provider heading (see mapSpawnQuickPickItems), so picking
 * a row is enough to spawn — mode/cwd/label/prompt all default. Picking a
 * gateway model (e.g. claude-sdk's kimi-k2.7-code) applies its bound mode
 * automatically, since a gateway id spawned in the adapter's default mode
 * routes to the wrong provider (moonshot's model id sent straight to
 * native Anthropic). The default cwd (active editor's folder → sole folder
 * → ambiguous folder pick → none, see resolveDefaultCwd) and its matching
 * daemon workspace slug are resolved up front and shown in the picker's
 * placeHolder, then sent explicitly on spawn rather than left to the
 * daemon's own inference — autodetection must be visible, never silent. A
 * trailing "$(gear) Configure…" row opens the full adapter → provider →
 * model → mode → cwd → label → prompt chain for anyone overriding a
 * default. Escape at any step aborts the whole wizard; an empty input box
 * in the Configure chain means "use the adapter default" and continues.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { UserPreset, WorkspacesConfig } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"
import { resolvePinnedTarget } from "../services/workspacePin.logic.js"
import type { WorkspacePinStore } from "../services/workspacePin.js"
import { EMPTY_WORKSPACES } from "../services/workspaces.logic.js"
import {
  assembleSpawnOptions,
  buildSpawnPlaceHolder,
  classifyProfileChoice,
  CUSTOM_MODEL_LABEL,
  mapAdapterQuickPickItems,
  mapCatalogSpawnQuickPickItems,
  mapFolderQuickPickItems,
  mapModeQuickPickItems,
  mapModelQuickPickItems,
  mapOrchestratorQuickPickItems,
  mapPermissionQuickPickItems,
  mapProviderQuickPickItems,
  mapSpawnQuickPickItems,
  modelEntriesOf,
  prependPresetGroup,
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
  workspacePin: WorkspacePinStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.spawnAgent", () => runSpawnWizard(client, store, workspacePin)),
  )
}

async function runSpawnWizard(client: DaemonClient, store: SessionStore, workspacePin: WorkspacePinStore): Promise<void> {
  // ── Fetch both adapters (for fallback) and catalog (preferred) ────────────
  let adapters: SpawnAdapterInfo[]
  let catalog: Awaited<ReturnType<DaemonClient["catalogModels"]>> | undefined
  try {
    adapters = (await client.listAdapters()) as SpawnAdapterInfo[]
  } catch (err) {
    vscode.window.showErrorMessage(`agentproto: could not list adapters — ${describeError(err)}`)
    return
  }
  try {
    catalog = await client.catalogModels()
  } catch {
    // Old daemon without /catalog/models — degrade to adapter manifest list
    catalog = undefined
  }

  if (adapters.length === 0) {
    vscode.window.showWarningMessage("agentproto: no adapters installed on the daemon.")
    return
  }

  let workspaceConfig: WorkspacesConfig
  try {
    workspaceConfig = await client.listWorkspaces()
  } catch {
    // Old daemon with no /workspaces route, or unreachable — degrade to no
    // slug rather than block the spawn; the daemon infers as it does today.
    workspaceConfig = EMPTY_WORKSPACES
  }

  let userPresets: UserPreset[]
  try {
    userPresets = await client.listUserPresets()
  } catch {
    // Old daemon without /user-presets, or unreachable — degrade to no
    // presets rather than block the spawn.
    userPresets = []
  }

  // A pin takes precedence over the folder-derivation ladder entirely — it's
  // the whole point of pinning a window to a workspace regardless of what
  // folder happens to be open in it. Only an unset pin, or a pin whose
  // workspace was since removed (resolvePinnedTarget returns undefined),
  // falls through to resolveWizardDefaultCwd/resolveWorkspaceSlug below.
  const pinnedTarget = resolvePinnedTarget(workspaceConfig, workspacePin.get())
  let defaultCwd: string
  let pinnedSlug: string | undefined
  if (pinnedTarget) {
    defaultCwd = pinnedTarget.cwd
    pinnedSlug = pinnedTarget.workspaceSlug
  } else {
    const cwdResolution = await resolveWizardDefaultCwd()
    if (cwdResolution === undefined) return // Escape during folder disambiguation aborts the wizard.
    defaultCwd = cwdResolution
  }

  const holdDefault = holdPermissionsSetting()
  let answers: SpawnWizardAnswers
  const pickerItems = prependPresetGroup(
    catalog && catalog.vendors.length > 0
      ? mapCatalogSpawnQuickPickItems(catalog)
      : mapSpawnQuickPickItems(adapters),
    userPresets,
  )
  const picked = await vscode.window.showQuickPick(pickerItems, {
    placeHolder: buildSpawnPlaceHolder(workspaceConfig, defaultCwd, holdDefault),
  })
  if (!picked) return
  if (picked.configure) {
    const configured = await runConfigureWizard(adapters, defaultCwd, holdDefault)
    if (!configured) return
    answers = configured
  } else if (picked.preset) {
    const preset = picked.preset
    let presetAdapter = preset.adapter ?? preset.harness
    if (!presetAdapter) {
      // This preset doesn't bind an adapter (UserPreset's own doc comment:
      // "Omitted means the caller selects one") — ask for one now rather
      // than send an empty adapter string, which the daemon would reject
      // (see http-server.ts's POST /sessions/agent: an explicit empty
      // string is NOT treated the same as an absent field, so it does NOT
      // fall through to the preset's own adapter).
      const adapterPick = await vscode.window.showQuickPick(mapAdapterQuickPickItems(adapters), {
        placeHolder: `"${preset.label}" preset has no adapter set — select one`,
      })
      if (!adapterPick) return
      presetAdapter = adapterPick.adapter.slug
    }
    answers = { adapter: presetAdapter, presetId: preset.id, permissionHold: holdDefault }
    if (preset.model) answers.model = preset.model
    if (!defaultCwd) {
      vscode.window.showWarningMessage(
        "agentproto: no folder open and no workspace pinned — pin a target workspace (status bar) or use Configure… to set a working directory.",
      )
      return
    }
    answers.cwd = defaultCwd
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
      if (picked.mode) answers.mode = picked.mode
    }
    // A catalog row carries the gateway + the profiles eligible to bill it.
    // Resolve the wallet here so a gateway model (openrouter/requesty/…) never
    // spawns walletless and 500s the daemon's serviceability guard.
    if (picked.route) {
      const resolved = await resolveRouteAccess(picked.route, picked.eligibleProfiles, picked.runnable)
      if (resolved === "abort") return
      answers.route = { gateway: picked.route }
      if (resolved.profileRef) answers.accessProfileRef = resolved.profileRef
    }
    if (!defaultCwd) {
      vscode.window.showWarningMessage(
        "agentproto: no folder open and no workspace pinned — pin a target workspace (status bar) or use Configure… to set a working directory.",
      )
      return
    }
    answers.cwd = defaultCwd
  } else {
    return
  }

  const slug = pinnedSlug ?? resolveWorkspaceSlug(workspaceConfig, answers.cwd)
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
    const session = await client.spawnAgent({ ...assembleSpawnOptions(answers), origin: "vscode" })
    void vscode.window
      .showInformationMessage(
        `agentproto: spawned ${session.label ?? session.id}`,
        "Open transcript",
        "Open story",
      )
      .then(choice => {
        if (choice === "Open transcript") {
          void vscode.commands.executeCommand("agentproto.openTranscript", session.id)
        } else if (choice === "Open story") {
          void vscode.commands.executeCommand("agentproto.openStory", session.id)
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

/**
 * The full chain: adapter → provider → model → mode → orchestrator →
 * permissions → cwd → label → prompt, reached only via the Configure… row.
 * Provider narrows the model list (an adapter with no declared models
 * skips straight to the model step's custom-only list, same as today).
 * The mode step only runs when the picked model carries no bound mode —
 * AIP-45 modes are mutually exclusive per turn, so a gateway model's bound
 * mode (moonshot/openrouter/…) already IS the mode; asking again would
 * only offer to override it with an incompatible one. A model with no
 * binding (native, custom-typed, or an adapter with no models at all)
 * still gets the free choice of any declared mode, unchanged.
 */
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

  const entries = modelEntriesOf(adapterPick.adapter)
  let boundMode: string | undefined
  let modelIds = entries.map((e) => e.id)
  if (entries.length > 0) {
    const providerPick = await vscode.window.showQuickPick(mapProviderQuickPickItems(adapterPick.adapter), {
      placeHolder: "Select a provider",
    })
    if (!providerPick) return undefined
    modelIds = entries.filter((e) => e.provider === providerPick.provider).map((e) => e.id)
  }

  const modelPick = await vscode.window.showQuickPick(mapModelQuickPickItems(modelIds), {
    placeHolder: "Select a model (Escape for adapter default)",
  })
  if (!modelPick) return undefined
  if (modelPick.custom) {
    const custom = await vscode.window.showInputBox({
      prompt: "Custom model id (leave empty for adapter default)",
    })
    if (custom === undefined) return undefined
    if (custom) answers.model = custom
  } else if (modelPick.label !== CUSTOM_MODEL_LABEL) {
    answers.model = modelPick.label
    boundMode = entries.find((e) => e.id === modelPick.label)?.mode
  }

  if (boundMode) {
    answers.mode = boundMode
  } else {
    const modeItems = mapModeQuickPickItems(adapterPick.adapter.modes)
    if (modeItems.length > 0) {
      const modePick = await vscode.window.showQuickPick(modeItems, { placeHolder: "Select a mode" })
      if (!modePick) return undefined
      answers.mode = modePick.mode
    }
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

/**
 * Resolve which named auth profile a catalog route should bill, driving a
 * quick-pick only when the choice is genuinely ambiguous. Returns the resolved
 * `profileRef` (or none, when the daemon's default wallet handles the route),
 * or the sentinel `"abort"` when the user dismisses the wallet pick or diverts
 * to connect a profile — the caller then cancels the spawn rather than firing
 * one the serviceability guard will reject. Branching mirrors
 * classifyProfileChoice; only the UI lives here.
 */
async function resolveRouteAccess(
  gateway: string,
  eligibleProfiles: string[] | undefined,
  runnable: boolean | undefined,
): Promise<{ profileRef?: string } | "abort"> {
  const choice = classifyProfileChoice(eligibleProfiles, runnable)
  switch (choice.kind) {
    case "attach":
      return { profileRef: choice.profileRef }
    case "default":
      return {}
    case "pick": {
      const pick = await vscode.window.showQuickPick(choice.options, {
        placeHolder: `Which ${gateway} wallet should bill this session?`,
      })
      if (pick === undefined) return "abort"
      return { profileRef: pick }
    }
    case "connect": {
      const action = await vscode.window.showWarningMessage(
        `No connected profile can bill this model on "${gateway}". Connect an ${gateway} API-key profile, then spawn again.`,
        "Connect a profile",
      )
      if (action === "Connect a profile") {
        await vscode.commands.executeCommand("agentproto.configureAuthProfile")
      }
      return "abort"
    }
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
