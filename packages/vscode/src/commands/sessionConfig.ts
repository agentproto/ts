/**
 * agentproto.configureSession — the per-session config picker (SPEC §6 build
 * step 8). Renders the dynamic chip strip from `buildSessionConfigChips` as a
 * two-level QuickPick (pick a chip → pick a row) and applies each pick through
 * its bound daemon verb: a live chip (model/effort/posture) switches in place;
 * a restart-only chip (route/access/contextProfile) — or a live chip's
 * restart-tagged row — applies via `session_restart` with an override. The
 * access chip's "+ add profile" row hands off to the create/login flow.
 *
 * Only chips whose option-set could be resolved from the daemon render; today
 * that is model, route, and access (effort/posture/contextProfile need
 * capability read-surfaces not yet plumbed to the client, so they hide until
 * then — SPEC §6 rule: an empty chip is omitted, never a dead affordance).
 *
 * All decisions are pure (`sessionConfig.logic.ts` builds the chips;
 * `sessionConfigDispatch.logic.ts` plans each pick); this file is the shell.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { RestartOverridePayload, SessionDescriptor } from "../client/types.js"
import { resumeBadge } from "./chipPickers.logic.js"
import type { SessionStore } from "../services/sessionStore.js"
import type { AuthProfilesTreeProvider } from "../views/authProfilesTree.js"
import { runCreateAuthProfileFlow } from "./authProfiles.js"
import { resolveSessionArg } from "./sessionActions.js"
import { describeSession } from "./sessionActions.logic.js"
import { RESTART_AFFIX, buildSessionConfigChips } from "./sessionConfig.logic.js"
import type { ConfigAxis, ConfigChip, ConfigChipRow } from "./sessionConfig.logic.js"
import {
  liveFallbackToRestart,
  planChipDispatch,
  type RestartOverride,
} from "./sessionConfigDispatch.logic.js"
import { describeRestart, type RestartResult } from "./sessionRestart.logic.js"

interface ChipItem extends vscode.QuickPickItem {
  chip: ConfigChip
}
interface RowItem extends vscode.QuickPickItem {
  row: ConfigChipRow
}

export function registerSessionConfig(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
  authProfiles: AuthProfilesTreeProvider,
  getActiveTranscriptSessionId: () => string | undefined = () => undefined,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.configureSession", (arg: unknown) =>
      configureSessionCommand(client, store, authProfiles, arg ?? getActiveTranscriptSessionId()),
    ),
    vscode.commands.registerCommand("agentproto.configureSessionAxis", (arg: unknown) =>
      configureSessionAxisCommand(client, store, authProfiles, arg),
    ),
  )
}

async function configureSessionCommand(
  client: DaemonClient,
  store: SessionStore,
  authProfiles: AuthProfilesTreeProvider,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(arg, store, "Select a session to configure", () => true, client)
  if (!session) return
  await runSessionConfigFlow(client, store, authProfiles, session)
}

interface ConfigureAxisArg {
  sessionId: string
  axis: ConfigAxis
}

function isConfigureAxisArg(arg: unknown): arg is ConfigureAxisArg {
  return (
    typeof arg === "object" &&
    arg !== null &&
    typeof (arg as ConfigureAxisArg).sessionId === "string" &&
    typeof (arg as ConfigureAxisArg).axis === "string" &&
    CONFIG_AXES.has((arg as ConfigureAxisArg).axis)
  )
}

const CONFIG_AXES: Set<ConfigAxis> = new Set([
  "model",
  "effort",
  "route",
  "access",
  "posture",
  "contextProfile",
])

async function configureSessionAxisCommand(
  client: DaemonClient,
  store: SessionStore,
  authProfiles: AuthProfilesTreeProvider,
  arg: unknown,
): Promise<void> {
  let sessionId: string | undefined
  let axis: ConfigAxis | undefined
  if (isConfigureAxisArg(arg)) {
    sessionId = arg.sessionId
    axis = arg.axis
  } else if (typeof arg === "string") {
    sessionId = arg
  }
  const session = await resolveSessionArg(
    sessionId,
    store,
    "Select a session to configure",
    () => true,
    client,
  )
  if (!session) return
  await runSessionConfigFlow(client, store, authProfiles, session, axis)
}

async function runSessionConfigFlow(
  client: DaemonClient,
  store: SessionStore,
  authProfiles: AuthProfilesTreeProvider,
  session: SessionDescriptor,
  targetAxis?: ConfigAxis,
): Promise<void> {
  if (!session.adapterSlug) {
    vscode.window.showWarningMessage(
      `agentproto: ${describeSession(session)} has no adapter recorded — nothing to configure.`,
    )
    return
  }

  const [adapters, catalog, profiles] = await Promise.all([
    client.listAdapters().catch(() => []),
    client.catalogModels().catch(() => undefined),
    client.listAuthProfiles().catch(() => []),
  ])
  const adapter = adapters.find(a => a.slug === session.adapterSlug)
  if (!adapter) {
    vscode.window.showWarningMessage(
      `agentproto: adapter \"${session.adapterSlug}\" is no longer installed.`,
    )
    return
  }

  const chips = buildSessionConfigChips(session, {
    adapter,
    ...(session.model ? { model: session.model } : {}),
    ...(catalog ? { catalog } : {}),
    profiles,
  })
  if (chips.length === 0) {
    vscode.window.showInformationMessage(
      `agentproto: ${describeSession(session)} exposes no configurable axes right now.`,
    )
    return
  }

  let chip: ConfigChip
  if (targetAxis) {
    const found = chips.find(c => c.axis === targetAxis)
    if (!found) {
      vscode.window.showInformationMessage(
        `agentproto: ${describeSession(session)} has no "${axisLabel(targetAxis)}" axis to configure right now.`,
      )
      return
    }
    chip = found
  } else {
    const chipPick = await vscode.window.showQuickPick<ChipItem>(
      chips.map(chip => ({
        label: `${axisLabel(chip.axis)}${chip.current ? `: ${chip.current}` : ""}`,
        ...(chip.restart ? { description: chip.restartAffix ?? RESTART_AFFIX } : {}),
        ...(chip.ineligibleAttachedProfile
          ? { detail: `⚠ attached profile \"${chip.ineligibleAttachedProfile}\" is no longer eligible — pick another` }
          : {}),
        chip,
      })),
      { title: `Configure ${describeSession(session)}`, placeHolder: "Which setting?" },
    )
    if (!chipPick) return
    chip = chipPick.chip
  }

  const rowPick = await vscode.window.showQuickPick<RowItem>(
    chip.rows.map(row => ({
      label: row.label,
      ...(row.description ? { description: row.description } : {}),
      ...(row.current ? { detail: "current" } : row.restartRequired ? { detail: RESTART_AFFIX } : {}),
      row,
    })),
    { title: `${axisLabel(chip.axis)} — ${describeSession(session)}`, placeHolder: "Pick a value" },
  )
  if (!rowPick) return

  const plan = planChipDispatch(chip, rowPick.row, session.model)
  switch (plan.kind) {
    case "noop":
      return
    case "addProfile":
      await runCreateAuthProfileFlow(client, authProfiles)
      await vscode.commands.executeCommand("agentproto.configureSession", session)
      return
    case "restart":
      await applyRestart(client, store, session, plan.axis, plan.override, plan.value)
      return
    case "live": {
      const result = await applyLive(client, session.id, plan.axis, plan.value)
      if (result.applied) {
        await store.refreshAll()
        return
      }
      if (liveFallbackToRestart(result)) {
        await applyRestart(client, store, session, plan.axis, plan.override, plan.value)
        return
      }
      vscode.window.showWarningMessage(
        `agentproto: ${axisLabel(plan.axis)} switch to \"${plan.value}\" didn't apply${result.reason ? ` — ${result.reason}` : ""}.`,
      )
    }
  }
}

/** Dispatch a live-switch verb for an axis, normalising the daemon's
 *  `{ applied, reason }` contract. Only model/effort/posture are live axes. */
async function applyLive(
  client: DaemonClient,
  sessionId: string,
  axis: "model" | "effort" | "posture" | string,
  value: string,
): Promise<{ applied?: boolean; reason?: string }> {
  try {
    // In-place switches over the dedicated HTTP routes (chip-pickers WP) — same
    // non-fatal { applied, reason } contract; a posture with no native mode
    // comes back { applied:false, reason:"requires-restart" }, which
    // liveFallbackToRestart routes into the restart-with-override path below.
    if (axis === "model") return await client.setSessionModel(sessionId, value)
    if (axis === "effort") return await client.setSessionEffort(sessionId, value)
    if (axis === "posture") return await client.setSessionPosture(sessionId, value)
    return { applied: false, reason: "not-supported" }
  } catch (err) {
    return { applied: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Apply an axis change via the restart-with-override route (chip-pickers WP):
 *  confirm (a restart is disruptive; the conversation carries over) → restart →
 *  REBIND the view to the new session id → badge what actually carried over from
 *  `resumeVia`/`resumeFallback`. A rejected override throws (never a silent
 *  blank session), surfaced as an error. */
async function applyRestart(
  client: DaemonClient,
  store: SessionStore,
  session: SessionDescriptor,
  axis: ConfigAxis,
  override: RestartOverride,
  value: string,
): Promise<void> {
  // We're about to restart — always confirm, even for a live axis that reached
  // here via requires-restart. The wording matches restartConfirmMessage's
  // contract (named axis + carry-over promise).
  const go = await vscode.window.showWarningMessage(
    `Switching ${axisLabel(axis)} to "${value}" restarts the session — the conversation carries over. Continue?`,
    { modal: true },
    "Restart & switch",
  )
  if (go !== "Restart & switch") return
  try {
    const result = await client.restartSessionWithOverride(session.id, override as RestartOverridePayload)
    await store.refreshAll()
    // Rebind: the restart minted a NEW session id — follow it, don't leave the
    // view on the dead session.
    await vscode.commands.executeCommand("agentproto.openTranscript", result.id)
    const badge = resumeBadge(result.resumeVia, result.resumeFallback)
    const restarted: RestartResult = {
      id: result.id,
      ...(result.label ? { label: result.label } : {}),
      ...(result.resumedFrom ? { resumedFrom: result.resumedFrom } : {}),
      ...(result.resumeVia ? { resumeVia: result.resumeVia } : {}),
      ...(result.resumeFallback ? { resumeFallback: "summary" } : {}),
    }
    vscode.window.showInformationMessage(`${describeRestart(session, restarted)} · ${badge.label}`)
  } catch (err) {
    vscode.window.showErrorMessage(
      `agentproto: restart failed — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function axisLabel(axis: string): string {
  switch (axis) {
    case "model":
      return "Model"
    case "effort":
      return "Effort"
    case "route":
      return "Route"
    case "access":
      return "Auth profile"
    case "posture":
      return "Posture"
    case "contextProfile":
      return "Context"
    default:
      return axis
  }
}
