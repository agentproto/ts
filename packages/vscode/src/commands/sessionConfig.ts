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
import type { SessionDescriptor } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"
import type { AuthProfilesTreeProvider } from "../views/authProfilesTree.js"
import { runCreateAuthProfileFlow } from "./authProfiles.js"
import { resolveSessionArg } from "./sessionActions.js"
import { describeSession } from "./sessionActions.logic.js"
import type { ConfigChip, ConfigChipRow } from "./sessionConfig.logic.js"
import { RESTART_AFFIX, buildSessionConfigChips } from "./sessionConfig.logic.js"
import {
  liveFallbackToRestart,
  planChipDispatch,
  type RestartOverride,
} from "./sessionConfigDispatch.logic.js"
import { describeRestart, parseRestartResult } from "./sessionRestart.logic.js"

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
  const chip = chipPick.chip

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

  const plan = planChipDispatch(chip, rowPick.row)
  switch (plan.kind) {
    case "noop":
      return
    case "addProfile":
      await runCreateAuthProfileFlow(client, authProfiles)
      await vscode.commands.executeCommand("agentproto.configureSession", session)
      return
    case "restart":
      await applyRestart(client, store, session, plan.override, plan.value)
      return
    case "live": {
      const result = await applyLive(client, session.id, plan.axis, plan.value)
      if (result.applied) {
        await store.refreshAll()
        return
      }
      if (liveFallbackToRestart(result)) {
        await applyRestart(client, store, session, plan.override, plan.value)
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
    if (axis === "model") return await client.setSessionModel(sessionId, value)
    if (axis === "effort") {
      return await client.mcpCall("agent_set_effort", { sessionId, effort: value })
    }
    if (axis === "posture") {
      return await client.mcpCall("agent_set_posture", { sessionId, posture: value })
    }
    return { applied: false, reason: "not-supported" }
  } catch (err) {
    return { applied: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Apply an axis change via `session_restart` with an override, revealing the
 *  new session on success and surfacing the daemon's reason on failure. */
async function applyRestart(
  client: DaemonClient,
  store: SessionStore,
  session: SessionDescriptor,
  override: RestartOverride,
  value: string,
): Promise<void> {
  try {
    const raw = await client.mcpCall("session_restart", { idOrName: session.id, ...override })
    const result = parseRestartResult(raw)
    await store.refreshAll()
    if (!result) {
      vscode.window.showErrorMessage(
        `agentproto: could not apply \"${value}\" — ${daemonErrorText(raw)}`,
      )
      return
    }
    vscode.window.showInformationMessage(describeRestart(session, result))
    await vscode.commands.executeCommand("agentproto.openTranscript", result.id)
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

function daemonErrorText(raw: unknown): string {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>
    if (typeof obj.message === "string") return obj.message
    if (typeof obj.error === "string") return obj.error
  }
  return "the daemon returned an unrecognised result"
}
