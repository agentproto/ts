/**
 * agentproto.answerSessionQuestion — one-click answers for a session paused
 * on an `awaitingQuestion` (the daemon's `SessionAwaitingQuestion`: a
 * context-continuity fork like "Context is at 69%. Continue fresh…", an
 * agent question, or a structured prompt).
 *
 * Shows the question text (with a "best-effort" hint when the daemon derived
 * it heuristically) and its options as a QuickPick — the daemon-recommended
 * option (`question.recommended`) is marked — and sends the chosen option
 * VERBATIM as the prompt through the normal prompt path
 * (`client.prompt(id, option, { wait: false })`, the same route
 * sessionActions.promptSession uses). The option string is not the message
 * the user sees typed back — it is the exact token the daemon's question
 * enumerated, which the runtime's answer-matching
 * (`package/session-event-bus.ts` awaitingQuestion protocol) recognizes.
 *
 * `arg` is a tree node / descriptor / bare session id (normalizeSessionArg,
 * same as every other session command). With no arg the command quick-picks
 * over the sessions currently awaiting a question.
 */

import * as vscode from "vscode"

import { normalizeSessionArg } from "./sessionActions.logic.js"
import {
  questionOptionItems,
  questionQuickPickTitle,
} from "./answerSessionQuestion.logic.js"
import type { SessionDescriptor } from "../client/types.js"
import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionStore } from "../services/sessionStore.js"

export function registerAnswerQuestionCommand(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.answerSessionQuestion", (arg?: unknown) =>
      answerSessionQuestionCommand(client, store, arg),
    ),
  )
}

async function answerSessionQuestionCommand(
  client: DaemonClient,
  store: SessionStore,
  arg: unknown,
): Promise<void> {
  const session = normalizeSessionArg(arg) ?? (await pickQuestionSession(store))
  if (!session) return
  // The row's snapshot may be a tick behind the daemon — resolve the fresh
  // descriptor so the question and its options are current.
  const live = store.sessions.find(s => s.id === session.id) ?? session
  const question = live.awaitingQuestion
  if (live.awaitingInput !== true || !question) {
    void vscode.window.showInformationMessage(
      "agentproto: that session is not waiting on a question right now.",
    )
    return
  }
  const items = questionOptionItems(question)
  if (items.length === 0) {
    // Options unknown — fall back to the composer: naming the question is
    // still progress over the old bare "!" row.
    await promptFreeText(client, live, question.text)
    return
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: questionQuickPickTitle(question),
    placeHolder: "Send as this session's next prompt",
  })
  if (!picked) return
  await sendAnswer(client, live, picked.option)
}

/** The option string goes through the normal prompt path, verbatim. */
async function sendAnswer(
  client: DaemonClient,
  session: SessionDescriptor,
  option: string,
): Promise<void> {
  try {
    await client.prompt(session.id, option, { wait: false })
    vscode.window.showInformationMessage(`agentproto: answered (${option})`)
  } catch (err) {
    vscode.window.showErrorMessage(
      `agentproto: answer failed — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Free-text fallback when the daemon couldn't enumerate options. */
async function promptFreeText(
  client: DaemonClient,
  session: SessionDescriptor,
  questionText: string,
): Promise<void> {
  const text = await vscode.window.showInputBox({
    prompt: `Answer: ${questionText}`,
    placeHolder: "Type the answer to send…",
  })
  if (!text) return
  await sendAnswer(client, session, text)
}

async function pickQuestionSession(store: SessionStore): Promise<SessionDescriptor | undefined> {
  const pending = store.sessions.filter(s => s.awaitingInput === true && s.awaitingQuestion)
  if (pending.length === 0) {
    void vscode.window.showInformationMessage("agentproto: no session is waiting on a question.")
    return undefined
  }
  if (pending.length === 1) return pending[0]
  const picked = await vscode.window.showQuickPick(
    pending.map(s => ({
      label: s.title ?? s.label ?? s.id,
      description: s.awaitingQuestion?.text,
      session: s,
    })),
    { placeHolder: "Select a session waiting on a question" },
  )
  return picked?.session
}
