/**
 * Pseudoterminal for an agent-cli session. Per the WP5 brief's verified
 * daemon facts, this session shape has NO PTY anywhere — its child speaks
 * ACP JSON-RPC over plain pipes. `GET /sessions/:id/stream` is the agent's
 * own pre-colored ANSI mirror (runtime/src/sessions.ts's `projectEvent`,
 * authored specifically so a terminal renders it as-is), so lines are
 * written to the Pseudoterminal VERBATIM: no markdown, no escaping, no ANSI
 * stripping. `SessionStore.focusOutput` is reused for the live tail rather
 * than opening a second SSE connection to the same endpoint.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor, SessionStreamLine } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"
import { isExited } from "../webview/transcript.logic.js"
import { createLineEditorState, feedLineEditor } from "./agentMirror.logic.js"
import { agentMirrorOpeningBanner, deadSessionBanner } from "./terminalSwitch.logic.js"

export function createAgentMirrorPty(
  client: DaemonClient,
  store: SessionStore,
  session: SessionDescriptor,
): vscode.Pseudoterminal {
  const writeEmitter = new vscode.EventEmitter<string>()

  let currentStatus = session.status
  let editor = createLineEditorState()
  let focusDisposable: vscode.Disposable | undefined
  let changeDisposable: vscode.Disposable | undefined
  let disposed = false

  /** A live session transitioning to exited WHILE the terminal is open — stop tailing, say so, leave the scrollback visible. */
  function markExited(latest: SessionDescriptor): void {
    if (disposed || isExited(currentStatus)) return
    currentStatus = latest.status
    focusDisposable?.dispose()
    focusDisposable = undefined
    writeEmitter.fire(`\r\n${deadSessionBanner(latest)}\r\n`)
  }

  return {
    onDidWrite: writeEmitter.event,
    open(): void {
      const exited = isExited(session.status)
      writeEmitter.fire(`${agentMirrorOpeningBanner(session)}\r\n`)

      // Subscribe to the live tail FIRST (buffering), then fetch the
      // backfilled snapshot, then flush — this closes the gap where a live
      // line could otherwise arrive between the preview() snapshot and the
      // SSE subscription starting. Mirrors the exact ordering
      // transcriptPanelController.ts uses for its own raw-mode fallback.
      let buffered: SessionStreamLine[] = []
      let ready = false
      const flush = (): void => {
        ready = true
        for (const line of buffered) writeEmitter.fire(`${line.line}\r\n`)
        buffered = []
      }

      if (!exited) {
        focusDisposable = store.focusOutput(session.id, {
          onLine: line => {
            if (ready) writeEmitter.fire(`${line.line}\r\n`)
            else buffered.push(line)
          },
        })
        changeDisposable = store.onDidChange(() => {
          const updated = store.sessions.find(s => s.id === session.id)
          if (updated && isExited(updated.status)) markExited(updated)
        })
      }

      void client.preview(session.id, 200).then(
        preview => {
          for (const line of preview.lines) writeEmitter.fire(`${line}\r\n`)
          flush()
        },
        () => flush(),
      )
    },
    close(): void {
      disposed = true
      focusDisposable?.dispose()
      focusDisposable = undefined
      changeDisposable?.dispose()
      changeDisposable = undefined
    },
    handleInput(data): void {
      if (isExited(currentStatus)) return
      const result = feedLineEditor(editor, data)
      editor = result.state
      writeEmitter.fire(result.echo)
      if (result.submit !== undefined && result.submit.length > 0) {
        void client.prompt(session.id, result.submit, { wait: false }).catch(err => {
          const message = err instanceof Error ? err.message : String(err)
          writeEmitter.fire(`\r\n\x1b[31m[send failed] ${message}\x1b[0m\r\n`)
        })
      }
    },
  }
}
