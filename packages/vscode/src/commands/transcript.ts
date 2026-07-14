/**
 * agentproto.openTranscript — a per-session OutputChannel. On first open it
 * seeds the channel from GET /sessions/:id/export (markdown), tolerating a
 * 422 (no native export available) by falling back to a short preview; it
 * then live-tails via SessionStore.focusOutput (SSE), which the store
 * enforces is single-stream. Re-invoking for the same session just reveals
 * its (already-live) channel; opening a *different* session's transcript
 * disposes the previous focus subscription BEFORE re-focusing, so we never
 * hold a stale Disposable that could tear down the new stream.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"
import { pickSession } from "./sessionActions.js"
import { normalizeSessionArg } from "./sessionActions.logic.js"
import { splitTranscriptLines, transcriptChannelName } from "./transcript.logic.js"

export function registerTranscript(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  const channels = new Map<string, vscode.OutputChannel>()
  let focusDisposable: vscode.Disposable | undefined
  let focusedSessionId: string | undefined

  ctx.subscriptions.push(new vscode.Disposable(() => focusDisposable?.dispose()))

  async function resolveTranscriptSession(arg: unknown): Promise<SessionDescriptor | undefined> {
    const known = normalizeSessionArg(arg)
    if (known) return known
    if (typeof arg === "string") {
      const fromStore = store.sessions.find(s => s.id === arg)
      if (fromStore) return fromStore
      try {
        return await client.getSession(arg)
      } catch (err) {
        vscode.window.showErrorMessage(`agentproto: session ${arg} not found — ${describeError(err)}`)
        return undefined
      }
    }
    return pickSession(store.sessions, "Select a session to open its transcript")
  }

  async function loadHistory(session: SessionDescriptor, channel: vscode.OutputChannel): Promise<void> {
    try {
      const exported = await client.exportSession(session.id, "markdown")
      for (const line of splitTranscriptLines(exported.content)) channel.appendLine(line)
      return
    } catch (err) {
      const message = describeError(err)
      if (!message.includes("422")) {
        vscode.window.showWarningMessage(
          `agentproto: export unavailable for ${session.label ?? session.id}, showing a preview instead (${message})`,
        )
      }
    }
    try {
      const preview = await client.preview(session.id, 200)
      for (const line of preview.lines) channel.appendLine(line)
    } catch (err) {
      channel.appendLine(`[agentproto] failed to load transcript: ${describeError(err)}`)
    }
  }

  async function openTranscript(arg: unknown): Promise<void> {
    const session = await resolveTranscriptSession(arg)
    if (!session) return

    let channel = channels.get(session.id)
    const isNew = !channel
    if (!channel) {
      channel = vscode.window.createOutputChannel(transcriptChannelName(session))
      channels.set(session.id, channel)
      ctx.subscriptions.push(channel)
    }
    channel.show(true)

    if (isNew) {
      await loadHistory(session, channel)
    }

    if (focusedSessionId !== session.id) {
      focusDisposable?.dispose()
      const target = channel
      focusDisposable = store.focusOutput(session.id, {
        onLine: line => target.appendLine(line.line),
      })
      focusedSessionId = session.id
    }
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.openTranscript", (arg: unknown) => openTranscript(arg)),
  )
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
