/**
 * agentproto.resumeSession — revive a daemon-restart ghost IN PLACE by
 * prompting the SAME session id, distinct from agentproto.restartSession
 * (which mints a NEW id). An agent-cli row killed by a daemon restart keeps
 * its descriptor + provider-side conversation on disk; a plain prompt to the
 * same id transparently resumes it (the daemon's lazy resume-on-prompt path,
 * #634/#635). So this command is just `promptSession` pointed at a ghost —
 * it goes through the ordinary prompt route, NOT `session_restart` — with
 * copy that names the resume-in-place semantics and surfaces #635's
 * interrupted-turn notice when the ghost died mid-turn. Eligibility is
 * `canResumeInPlace` (sessionResume.logic.ts); the tree only offers it on
 * `session-interrupted` rows.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionStore } from "../services/sessionStore.js"
import { resolveSessionArg } from "./sessionActions.js"
import { describeSession } from "./sessionActions.logic.js"
import {
  canResumeInPlace,
  describeResume,
  resumeInterruptedNotice,
  runResumeInPlace,
} from "./sessionResume.logic.js"

export function registerSessionResume(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.resumeSession", (arg: unknown) =>
      resumeSessionCommand(client, store, arg),
    ),
  )
}

async function resumeSessionCommand(
  client: DaemonClient,
  store: SessionStore,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(
    arg,
    store,
    "Select a daemon-restart session to resume in place",
    canResumeInPlace,
  )
  if (!session) return

  if (!canResumeInPlace(session)) {
    vscode.window.showWarningMessage(
      `agentproto: ${describeSession(session)} isn't a daemon-restart session — resume-in-place only applies to an agent-cli session that died when its daemon restarted. Use Restart for other cases.`,
    )
    return
  }

  try {
    const outcome = await runResumeInPlace(session, {
      getInput: box =>
        Promise.resolve(vscode.window.showInputBox(box)).then(value => value ?? undefined),
      // Fire-and-forget, mirroring promptSession: the prompt is queued and the
      // daemon resumes the session as it dequeues it. `wait:false` so a resume
      // whose first turn is long doesn't hang the command.
      sendPrompt: (id, text) => client.prompt(id, text, { wait: false }).then(() => undefined),
    })
    if (!outcome.resumed) return
    // The interrupted banner (#635) is written server-side into the transcript
    // on resume; echo it here too so the user sees it at the moment of acting,
    // not only after opening the transcript.
    const notice = resumeInterruptedNotice(session)
    vscode.window.showInformationMessage(
      notice ? `${describeResume(session)} Note: ${notice}.` : describeResume(session),
    )
  } catch (err) {
    vscode.window.showErrorMessage(
      `agentproto: resume of ${describeSession(session)} failed — ${describeError(err)}`,
    )
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
