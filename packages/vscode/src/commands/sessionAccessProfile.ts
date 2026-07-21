/**
 * agentproto.setSessionAccessProfile — attach a named auth profile (the wallet a
 * session bills against) to an existing agent-cli session. Access is a
 * restart-only axis (SPEC §4.3): the command drives the daemon's
 * `session_restart` with an `access` override, which re-resolves billing and
 * respawns the session resuming its conversation. This is the sessionConfig
 * `access` chip made actionable as a standalone command.
 *
 * All decisions live in the pure `sessionAccessProfile.logic.ts`; this file is
 * the vscode shell. The "+ add profile" row hands off to the create/login flow
 * (`runCreateAuthProfileFlow`) and re-opens so the fresh profile can be picked.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"
import type { AuthProfilesTreeProvider } from "../views/authProfilesTree.js"
import { runCreateAuthProfileFlow } from "./authProfiles.js"
import { resolveSessionArg } from "./sessionActions.js"
import { describeSession, isLiveSession } from "./sessionActions.logic.js"
import { accessRowsForSession, planAccessChange } from "./sessionAccessProfile.logic.js"
import { describeRestart, parseRestartResult } from "./sessionRestart.logic.js"

/** Access is a restart-with-override, which only applies to agent-cli sessions
 *  (a PTY/command session has no billing axis) — mirror the daemon's own guard. */
const isAgentCli = (session: SessionDescriptor): boolean => session.kind === "agent-cli"

export function registerSessionAccessProfile(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
  authProfiles: AuthProfilesTreeProvider,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.setSessionAccessProfile", (arg: unknown) =>
      setSessionAccessProfileCommand(client, store, authProfiles, arg),
    ),
  )
}

async function setSessionAccessProfileCommand(
  client: DaemonClient,
  store: SessionStore,
  authProfiles: AuthProfilesTreeProvider,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(
    arg,
    store,
    "Select a session to set its auth profile",
    isAgentCli,
  )
  if (!session) return
  if (!isAgentCli(session)) {
    vscode.window.showWarningMessage(
      `agentproto: ${describeSession(session)} is not an agent session — only agent-cli sessions bill against an auth profile.`,
    )
    return
  }

  const [catalog, profiles] = await Promise.all([
    client.catalogModels().catch(() => undefined),
    client.listAuthProfiles().catch(() => []),
  ])

  const { rows, ineligibleAttached, currentProfileRef } = accessRowsForSession({
    descriptor: session,
    catalog,
    profiles,
  })
  if (ineligibleAttached) {
    vscode.window.showWarningMessage(
      `agentproto: the attached profile \"${ineligibleAttached}\" is no longer eligible for this session's route — pick another.`,
    )
  }

  const pick = await vscode.window.showQuickPick(
    rows.map(row => ({
      label: row.label,
      ...(row.description ? { description: row.description } : {}),
      ...(currentProfileRef && row.value === currentProfileRef ? { picked: true, description: `${row.description ?? ""} (current)`.trim() } : {}),
      value: row.value,
      addProfile: row.addProfile,
    })),
    {
      title: `Auth profile — ${describeSession(session)}`,
      placeHolder: "Pick the wallet this session bills against",
    },
  )
  if (!pick) return

  const plan = planAccessChange({
    picked: { value: pick.value, addProfile: pick.addProfile },
    ...(currentProfileRef ? { currentProfileRef } : {}),
    isLive: isLiveSession(session),
  })

  if (plan.kind === "noop") return
  if (plan.kind === "addProfile") {
    await runCreateAuthProfileFlow(client, authProfiles)
    // Re-open so the freshly-created profile can be attached in one motion.
    await vscode.commands.executeCommand("agentproto.setSessionAccessProfile", session)
    return
  }

  // plan.kind === "attach"
  if (plan.killFirst) {
    const choice = await vscode.window.showWarningMessage(
      `Restart ${describeSession(session)} onto \"${plan.profileRef}\"?`,
      {
        modal: true,
        detail:
          "The session is live — switching its wallet ends the current turn and respawns it on the new profile, resuming the conversation.",
      },
      "Restart",
    )
    if (choice !== "Restart") return
    try {
      await client.kill(session.id)
    } catch (err) {
      vscode.window.showErrorMessage(
        `agentproto: could not stop the session before re-attaching — ${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }
  }

  try {
    const raw = await client.mcpCall("session_restart", {
      idOrName: session.id,
      access: { profileRef: plan.profileRef },
    })
    const result = parseRestartResult(raw)
    await store.refreshAll()
    if (!result) {
      vscode.window.showErrorMessage(
        `agentproto: could not attach \"${plan.profileRef}\" — ${daemonErrorText(raw)}`,
      )
      return
    }
    vscode.window.showInformationMessage(
      `${describeRestart(session, result)} — now on profile \"${plan.profileRef}\".`,
    )
    await vscode.commands.executeCommand("agentproto.openTranscript", result.id)
  } catch (err) {
    vscode.window.showErrorMessage(
      `agentproto: attach failed — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Pull the daemon's own reason out of a non-restart result (e.g. a 400 for an
 *  ineligible profile: `{ error, message, status }`), falling back to a compact
 *  JSON dump so the user never sees a bare "unrecognised result". */
function daemonErrorText(raw: unknown): string {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>
    if (typeof obj.message === "string") return obj.message
    if (typeof obj.error === "string") return obj.error
  }
  return "the daemon returned an unrecognised result"
}
