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
import {
  accessRowsForSession,
  applyAccessProfile,
  planAccessChange,
} from "./sessionAccessProfile.logic.js"
import { describeRestart } from "./sessionRestart.logic.js"

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
    // Adapter-scoped: the unscoped route union would list wallets this
    // session's own adapter cannot bill — never pre-select one of those.
    client.catalogModels(session.adapterSlug).catch(() => undefined),
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
    rows.map(row => {
      const isCurrent = Boolean(currentProfileRef && row.value === currentProfileRef)
      const description = [
        row.description,
        isCurrent ? "(current)" : undefined,
        row.eligible === false ? "not eligible for this route" : undefined,
      ]
        .filter(Boolean)
        .join(" ")
      return {
        label: row.label,
        ...(description ? { description } : {}),
        ...(isCurrent ? { picked: true } : {}),
        value: row.value,
        addProfile: row.addProfile,
      }
    }),
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

  // The daemon's restart-with-override route (`POST /sessions/:id/restart`)
  // with the picked profile as the ACCESS override: the session keeps its
  // posture, the conversation is resumed under a new id, and the daemon
  // re-arms the cron jobs that targeted the old id.
  const applied = await applyAccessProfile({
    applier: client,
    sessionId: session.id,
    profileRef: plan.profileRef,
  })
  await store.refreshAll()
  if (!applied.ok) {
    vscode.window.showErrorMessage(
      `agentproto: could not attach \"${plan.profileRef}\": ${daemonErrorText(applied.error)}`,
    )
    return
  }
  const result = applied.restart
  if (!result) {
    vscode.window.showErrorMessage(
      `agentproto: could not attach \"${plan.profileRef}\": the daemon returned an unrecognised result`,
    )
    return
  }
  vscode.window.showInformationMessage(
    `${describeRestart(session, result)}: now on profile \"${plan.profileRef}\".`,
  )
  await vscode.commands.executeCommand("agentproto.openTranscript", result.id)
}

/** Pull the daemon's own reason out of a non-restart result (e.g. a 400 for an
 *  ineligible profile: `{ error, message, status }`), falling back to a compact
 *  JSON dump so the user never sees a bare "unrecognised result". */
function daemonErrorText(raw: unknown): string {
  if (typeof raw === "string") {
    const text = raw.trim()
    if (!text) return "the daemon returned an unrecognised result"
    // The client wraps a failed request as "POST … failed: HTTP 400 {json}";
    // the daemon's own reason is inside that JSON: show it, not the wrapper.
    const start = text.indexOf("{")
    if (start >= 0) {
      try {
        const parsed = JSON.parse(text.slice(start)) as Record<string, unknown>
        const nested =
          parsed.error && typeof parsed.error === "object"
            ? (parsed.error as Record<string, unknown>)
            : undefined
        const message =
          nested?.message ?? nested?.reason ?? parsed.message ?? parsed.error
        if (typeof message === "string" && message.length > 0) return message
      } catch {
        // not JSON: fall through to the raw text
      }
    }
    return text
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>
    if (typeof obj.message === "string") return obj.message
    if (typeof obj.error === "string") return obj.error
  }
  return "the daemon returned an unrecognised result"
}
