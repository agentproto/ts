/**
 * Transcript webview panel — a live chat/output view for a single session.
 *
 * Implements the WP4 contract:
 *   - One WebviewPanel per session id (viewType `agentproto.transcript`).
 *   - Theme-aware HTML using VS Code's CSS variables.
 *   - Initial transcript rendered from `exportSession("markdown")` with a
 *     `preview(200)` fallback.
 *   - Live output streamed via `SessionStore.focusOutput()`.
 *   - Send / interrupt-send wired to the daemon client. NOT kill: that lives
 *     in the sessions tree (`agentproto.killSession`), not under the user's
 *     eyes as a permanently-red slab beside the thing they type into.
 *   - Clean disposal of subscriptions when the panel closes.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"

import { registerOutputDocuments, type OutputDocuments } from "../services/outputDocument.js"
import { activityFor, TREE_REPAINT_INTERVAL_MS, type SessionActivity } from "../views/sessionsTree.logic.js"
import { TAB_ICON_DIR, tabIconFor } from "./tabIcon.logic.js"
import { TOOL_IO_MAX_LINES } from "./conversation.js"
import type { SeenTracker } from "../services/seen.js"
import { formatTitle } from "./transcript.logic.js"
import { isWebviewMessage, type ExtMessage, type WebviewMessage } from "./protocol.js"
import { TranscriptPanelController } from "./transcriptPanelController.js"

export interface TranscriptPanels {
  open(session: SessionDescriptor): void
  /**
   * Session id of the currently focused transcript panel tab, if any. Lets
   * `agentproto.openTerminal`'s editor-title-bar entry point (WP5) target
   * "this" session without an explicit arg — a plain `editor/title` menu
   * command receives none, unlike a tree item's `view/item/context` command.
   */
  activeSessionId(): string | undefined
}

export function registerTranscriptPanels(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
  seen: SeenTracker,
): TranscriptPanels {
  const panels = new Map<string, vscode.WebviewPanel>()
  let activeId: string | undefined
  // One provider for every panel: the scheme is registered once per
  // extension activation, and each document's URI is already unique per
  // session/segment/field.
  const outputDocs = registerOutputDocuments(ctx)

  /** What each tab's icon was last painted for — assigning iconPath makes VS
   *  Code re-render the tab, so only a real CHANGE should do it. Keyed on
   *  activity AND unread: they're two axes, and a session going from unread to
   *  read never changes its activity, so an activity-only key would swallow
   *  exactly the repaint that clears the dot. */
  const painted = new Map<string, string>()

  const paintTabIcon = (panel: vscode.WebviewPanel, session: SessionDescriptor): void => {
    const activity = activityFor(session, Date.now())
    const unread = seen.isUnread(session)
    const key = `${activity}:${unread}`
    if (painted.get(session.id) === key) return
    painted.set(session.id, key)
    const icon = tabIconFor(activity, unread)
    panel.iconPath = {
      light: vscode.Uri.joinPath(ctx.extensionUri, ...TAB_ICON_DIR, icon.light),
      dark: vscode.Uri.joinPath(ctx.extensionUri, ...TAB_ICON_DIR, icon.dark),
    }
  }

  // Repaint every open tab on a clock as well as on change. `stalled` is a
  // function of elapsed silence, so the one state a wedged tab needs to reach
  // is the one no event will ever announce — same reasoning, same interval, as
  // the sessions tree.
  const repaintTabs = (): void => {
    for (const [id, panel] of panels) {
      const session = store.sessions.find(s => s.id === id)
      if (session) paintTabIcon(panel, session)
    }
  }

  const repaintTimer = setInterval(repaintTabs, TREE_REPAINT_INTERVAL_MS)
  ctx.subscriptions.push(new vscode.Disposable(() => clearInterval(repaintTimer)))

  // A receipt changing is a repaint like any other. Without this, reading one
  // transcript would clear its dot in the tree while its own tab kept the
  // filled one until some unrelated event happened by — the two disagreeing
  // about the same session, which is the thing this is supposed to fix.
  ctx.subscriptions.push(seen.onDidChange(repaintTabs))

  /**
   * The operator has eyes on this session — clear its unread dot. Re-read from
   * the store rather than trusting a captured descriptor: the receipt is
   * compared against `lastOutputAt`, so a stale copy would mark output read
   * that arrived after it was captured.
   */
  const markSeenNow = (id: string): void => {
    const session = store.sessions.find(s => s.id === id)
    if (session) seen.markSeen(session)
  }

  return {
    open(session: SessionDescriptor): void {
      const existing = panels.get(session.id)
      if (existing) {
        existing.reveal(vscode.ViewColumn.One, false)
        activeId = session.id
        markSeenNow(session.id)
        return
      }

      const panel = vscode.window.createWebviewPanel(
        "agentproto.transcript",
        formatTitle(session),
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      )
      panels.set(session.id, panel)
      activeId = session.id
      // The tab wears the session's state, and keeps wearing it: without this
      // a transcript was a generic document glyph, indistinguishable from
      // every other open editor — and these tabs stay open for hours while
      // the thing behind them changes.
      paintTabIcon(panel, session)
      markSeenNow(session.id)

      const nonce = randomNonce()

      const disposables: vscode.Disposable[] = []

      const controller = new TranscriptPanelController({
        sessionId: session.id,
        initialSession: session,
        client,
        store,
        messenger: panel.webview,
      })
      disposables.push(controller)

      // Live session updates (cost, status, tokens).
      disposables.push(
        store.onDidChange(() => {
          const updated = store.sessions.find(s => s.id === session.id)
          if (!updated) return
          controller.onSessionUpdate(updated)
          paintTabIcon(panel, updated)
          // Watching output arrive IS reading it — while this tab is the
          // focused one, new output must never mark the session unread behind
          // the operator's back. A hidden or background tab gets no such
          // credit: that output really is unread.
          if (activeId === session.id) seen.markSeen(updated)
        }),
      )

      // Message handling from the webview. Register before setting HTML so the
      // handler is in place if the webview posts `ready` synchronously.
      disposables.push(
        panel.webview.onDidReceiveMessage(async (raw: unknown) => {
          if (!isWebviewMessage(raw)) return
          try {
            await handleWebviewMessage(raw, controller, outputDocs)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            void vscode.window.showErrorMessage(`agentproto: ${message}`)
          }
        }),
      )

      // Track focus so activeSessionId() reflects whichever transcript tab
      // the user is actually looking at (switching tabs doesn't re-run open()).
      disposables.push(
        panel.onDidChangeViewState(e => {
          if (e.webviewPanel.active) {
            activeId = session.id
            // Switching TO a tab is the commonest way of looking at a session
            // — open() only runs the first time.
            markSeenNow(session.id)
          } else if (activeId === session.id) activeId = undefined
        }),
      )

      // Cleanup on close.
      panel.onDidDispose(() => {
        for (const d of disposables) d.dispose()
        panels.delete(session.id)
        // Forget the painted state too: a reopened tab is a fresh panel with
        // no icon, so a stale entry here would suppress its first paint and
        // leave it wearing VS Code's generic glyph.
        painted.delete(session.id)
        if (activeId === session.id) activeId = undefined
      })

      // Set HTML only after the controller and message listener are wired up.
      panel.webview.html = buildHtml(nonce)
    },
    activeSessionId(): string | undefined {
      return activeId
    },
  }
}

async function handleWebviewMessage(
  msg: WebviewMessage,
  controller: TranscriptPanelController,
  outputDocs: OutputDocuments,
): Promise<void> {
  switch (msg.type) {
    case "ready":
      await controller.onReady()
      return
    case "send":
      await controller.onSend(msg.text, false)
      return
    case "interruptSend":
      await controller.onSend(msg.text, true)
      return
    case "openToolIo": {
      const doc = controller.resolveToolIo(msg.segmentId, msg.field)
      if (!doc) {
        // The only way here is a call whose result hasn't landed yet — say
        // that, rather than opening a blank tab and looking broken.
        void vscode.window.showInformationMessage(
          `agentproto: this tool call has no ${msg.field} yet.`,
        )
        return
      }
      await outputDocs.show(doc.name, doc.text)
      return
    }
  }
}

function randomNonce(): string {
  // CSP nonce — must be unguessable, so use a CSPRNG, not Math.random().
  return randomBytes(16).toString("hex")
}

/**
 * Exported so transcriptPanel.dom.test.ts can build the EXACT HTML/script the
 * extension ships and execute it in jsdom — the reconciliation logic in the
 * inline script is the load-bearing part of this module and has no other
 * way to get automated coverage without a real webview host.
 */
export function buildHtml(nonce: string): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ")

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>agentproto transcript</title>
  <style>
    :root {
      color: var(--vscode-editor-foreground);
      background-color: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    body {
      display: flex;
      flex-direction: column;
    }
    #header {
      flex: 0 0 auto;
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, rgba(128,128,128,0.3)));
      background-color: var(--vscode-sideBar-background);
    }
    #header-title {
      font-weight: 600;
      font-size: 1.1em;
      margin-bottom: 4px;
      color: var(--vscode-sideBarTitle-foreground);
    }
    #header-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    .chip {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 0.85em;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .chip-running { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
    /* chip-busy kept for any descriptor path still reporting it; working/
       waiting/stalled are what computeStatusChip actually emits now. */
    .chip-busy, .chip-working { background: var(--vscode-progressBar-background); color: var(--vscode-editor-background); }
    .chip-waiting { background: var(--vscode-descriptionForeground); color: var(--vscode-editor-background); }
    .chip-stalled { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
    .chip-awaiting-input { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
    .chip-exited { background: var(--vscode-testing-iconFailed); color: var(--vscode-editor-background); }
    .chip-starting { background: var(--vscode-descriptionForeground); color: var(--vscode-editor-background); }
    .chip-blocked { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
    #header-blocked:empty { display: none; }
    #transcript {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 12px 14px;
      line-height: 1.5;
    }
    #transcript p { margin: 0 0 10px; }
    #transcript h1, #transcript h2, #transcript h3, #transcript h4, #transcript h5, #transcript h6 {
      margin: 12px 0 6px;
      color: var(--vscode-editor-foreground);
    }
    #transcript pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 10px;
      border-radius: 4px;
      overflow-x: auto;
    }
    #transcript code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.95em;
    }
    #transcript blockquote {
      margin: 0 0 10px;
      padding-left: 12px;
      border-left: 3px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
    }
    #transcript ul, #transcript ol { margin: 0 0 10px 18px; padding: 0; }
    #transcript li { margin-bottom: 2px; }
    .line {
      font-family: var(--vscode-editor-font-family);
      white-space: pre-wrap;
      word-break: break-word;
      margin-bottom: 2px;
    }
    .line-stderr { color: var(--vscode-errorForeground); }
    /* ── Structured chat timeline ─────────────────────────────────── */
    .turn { margin: 0 0 14px; }
    .turn .role {
      font-size: 0.78em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    .turn-user .bubble, .turn-assistant .bubble { border-radius: 6px; padding: 8px 12px; }
    .turn-user .bubble {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    }
    .turn-assistant .bubble { background: transparent; }
    .seg { margin: 0 0 8px; }
    .seg:last-child { margin-bottom: 0; }
    .seg.text > :first-child { margin-top: 0; }
    .seg.text > :last-child { margin-bottom: 0; }
    /* A GROUP is a box (it contains things). A STEP is a row. Nesting a
       bordered card inside a bordered group drew two frames around one fact
       and left no quiet surface to read. */
    details.activity {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 5px;
      background: var(--vscode-textCodeBlock-background);
      padding: 3px 8px;
    }
    details.reasoning, details.tool {
      border-radius: 4px;
      padding: 1px 4px;
    }
    /* A top-level step still needs an edge to sit against the chat bubbles;
       inside a group the tree line already does that job. */
    .turn > details.reasoning, .turn > details.tool {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      padding: 3px 8px;
      background: var(--vscode-textCodeBlock-background);
    }
    .reasoning-body {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    /* ── One disclosure row: status ─ name ─────────────── chevron ── */
    details.reasoning > summary, details.tool > summary, details.activity > summary {
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      /* The native triangle is stuck on the left, where it fights the status
         glyph for the first thing the eye lands on. */
      list-style: none;
    }
    details > summary::-webkit-details-marker { display: none; }
    details.reasoning[open] > summary,
    details.tool[open] > summary,
    details.activity[open] > summary { margin-bottom: 6px; }
    details.tool > summary { font-family: var(--vscode-editor-font-family); }
    .seg-badge {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1em;
    }
    /* The cross IS the failure report — the container stays quiet. */
    .seg-badge.badge-error { color: var(--vscode-errorForeground); }
    .seg-badge.badge-ok { opacity: 0.55; }
    /* The live step: a pulsing dot, so the eye finds the one thing happening
       now without reading a word. */
    .seg-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--vscode-editorWarning-foreground);
      animation: agentproto-pulse 1.1s ease-in-out infinite;
    }
    .seg-label {
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-editor-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .seg-elapsed {
      flex: 0 0 auto;
      color: var(--vscode-editorWarning-foreground);
      font-variant-numeric: tabular-nums;
    }
    .seg-elapsed:empty { display: none; }
    /* Faint on purpose: it's an affordance, not information. It only has to
       be findable once you're already looking at the row. */
    .seg-chev {
      flex: 0 0 auto;
      margin-left: auto;
      padding-left: 8px;
      opacity: 0.32;
      transition: transform 0.12s ease;
    }
    details[open] > summary > .seg-chev { transform: rotate(90deg); }
    summary:hover > .seg-chev { opacity: 0.7; }
    /* The fold's children indent under the summary so the run reads as a tree. */
    .act-children {
      border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      margin-left: 4px;
      padding-left: 8px;
    }
    /* Consecutive tool segments read as one compact group instead of N
       separately-bordered cards — see markToolRuns() in the script. */
    .seg.tool.tool-run-start, .seg.tool.tool-run-mid { margin-bottom: 0; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
    .seg.tool.tool-run-mid, .seg.tool.tool-run-end { border-top: none; border-top-left-radius: 0; border-top-right-radius: 0; }
    .tool-field-label {
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--vscode-descriptionForeground);
      margin: 4px 0 2px;
    }
    /* Clamped to TOOL_IO_MAX_LINES rows and clipped horizontally — a tool
       card shows what the call was, not what it returned in full. pre
       (not pre-wrap) is deliberate: wrapping one 900-char line would blow
       the whole line budget on a single line, so long lines clip and the
       block opens in an editor on click. */
    .tool-args, .tool-result {
      margin: 0;
      background: var(--vscode-editor-background);
      padding: 6px 8px;
      border-radius: 4px;
      overflow: hidden;
      white-space: pre;
      text-overflow: ellipsis;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      line-height: 1.4;
      cursor: pointer;
    }
    .tool-args:hover, .tool-result:hover {
      outline: 1px solid var(--vscode-focusBorder);
    }
    /* "Cut here" — a dashed edge, not a fade. The preview is exactly
       MAX_IO_LINES tall, so a gradient mask would dissolve the last line the
       user can actually read in exchange for saying what the link below
       already says outright. */
    .tool-io-clamped {
      border-bottom: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.4));
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
    }
    .tool-io-open {
      display: inline-block;
      margin: 2px 0 4px;
      font-size: 0.8em;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      user-select: none;
    }
    .tool-io-open:hover { text-decoration: underline; }
    @keyframes agentproto-pulse {
      0%, 100% { opacity: 0.35; transform: scale(0.85); }
      50% { opacity: 1; transform: scale(1); }
    }
    /* A step that has outrun the stall threshold. Deliberately only weight:
       the elapsed is already warning-coloured while a step runs, so the
       escalation is "this number is now shouting", not another border. */
    .tool-still-running > summary > .seg-elapsed { font-weight: 600; }
    .seg.plan {
      border-left: 3px solid var(--vscode-progressBar-background);
      padding: 4px 0 4px 10px;
    }
    .plan-head { font-weight: 600; font-size: 0.9em; margin-bottom: 4px; }
    .plan-list { list-style: none; margin: 0; padding: 0; }
    .plan-list li { font-size: 0.92em; }
    .plan-list li.plan-completed { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
    .seg.question {
      border-left: 3px solid var(--vscode-editorWarning-foreground);
      padding: 4px 0 4px 10px;
    }
    .seg.error {
      color: var(--vscode-errorForeground);
      border-left: 3px solid var(--vscode-errorForeground);
      padding: 4px 0 4px 10px;
      white-space: pre-wrap;
    }
    #conv-usage { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    /* ── Working row ──────────────────────────────────────────────────
       The one always-visible answer to "is it doing anything?", sitting
       between the timeline and the composer so it stays put while the
       transcript scrolls. Only shown while a turn is actually in flight. */
    #working {
      flex: 0 0 auto;
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 6px 14px 0;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    #working[hidden] { display: none; }
    #working-glyph {
      color: var(--vscode-progressBar-background);
      animation: agentproto-spin 1.6s linear infinite;
    }
    /* Stop the spinner: nothing is spinning. */
    #working.stalled { color: var(--vscode-editorWarning-foreground); }
    #working.stalled #working-glyph {
      animation: none;
      color: var(--vscode-editorWarning-foreground);
    }
    @keyframes agentproto-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    /* Honour the OS "reduce motion" setting — this thing spins for minutes. */
    @media (prefers-reduced-motion: reduce) {
      #working-glyph { animation: none; }
      /* The dot stays — solid and warning-coloured it still marks the live
         step; only the pulsing goes. */
      .seg-dot { animation: none; }
      .seg-chev { transition: none; }
    }
    /* ── Composer ─────────────────────────────────────────────────────
       One bordered box that OWNS the textarea and its action row, rather
       than a textarea sitting next to a stack of coloured buttons. Actions
       are ghost-styled and live inside the box on one line: the destructive
       one earns colour on hover only, so a red slab never sits permanently
       under the user's eyes. */
    #input-area {
      flex: 0 0 auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px 14px 12px;
      background-color: var(--vscode-editor-background);
    }
    /* ── Error banner ─────────────────────────────────────────────────
       Errors used to be one line of red text wedged under the buttons,
       clipped mid-sentence — the daemon's actual reason was unreadable. A
       banner above the composer gets the full message, selectable so it can
       be copied into a bug report, and a dismiss. */
    #error-banner {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
      background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1));
      border-radius: 6px;
    }
    #error-banner[hidden] { display: none; }
    #eb-icon { flex: 0 0 auto; color: var(--vscode-errorForeground); }
    #eb-body { flex: 1 1 auto; min-width: 0; }
    #eb-title { font-weight: 600; margin-bottom: 2px; }
    #eb-message {
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
      /* The whole reason this exists: never clip the daemon's message. */
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
    }
    #eb-dismiss { flex: 0 0 auto; }
    /* ── Queued message ───────────────────────────────────────────────
       A prompt typed mid-turn is held here rather than rejected. */
    #queued {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.4));
      border-radius: 6px;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    #queued[hidden] { display: none; }
    #queued-label {
      flex: 1 1 auto;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #queued-cancel { flex: 0 0 auto; }
    #composer {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 10px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.35)));
      border-radius: 8px;
      background: var(--vscode-input-background);
    }
    #composer:focus-within { border-color: var(--vscode-focusBorder); }
    #composer.disabled { opacity: 0.6; }
    #input {
      width: 100%;
      resize: none;
      min-height: 22px;
      max-height: 200px;
      overflow-y: auto;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.4;
    }
    #input:focus { outline: none; }
    #input::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
    #input:disabled { cursor: not-allowed; }
    #composer-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    /* Which agent/model will answer belongs where you type, not only in the
       header — so the header no longer repeats it. */
    #composer-meta {
      flex: 1 1 auto;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .composer-chip {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .composer-chip:empty { display: none; }
    button {
      padding: 3px 8px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
    }
    button:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
      color: var(--vscode-editor-foreground);
    }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    /* Hidden rather than disabled: interrupting a session that isn't working
       on anything is a no-op, so the affordance shouldn't be there at all. */
    button[hidden] { display: none; }
    #kill:hover:not(:disabled) {
      background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.12));
      color: var(--vscode-errorForeground);
    }
    /* The submit key. Stays quiet until there is actually something to send. */
    #send {
      flex: 0 0 auto;
      min-width: 26px;
      font-size: 1em;
      line-height: 1;
      padding: 4px 8px;
    }
    #send.has-text {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #send.has-text:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
      color: var(--vscode-button-foreground);
    }
    #send-status {
      flex: 0 0 auto;
      color: var(--vscode-errorForeground);
    }
    #send-status:empty { display: none; }
    #empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 20px 0;
    }
  </style>
</head>
<body>
  <div id="header">
    <div id="header-title"></div>
    <div id="header-meta">
      <span id="status-chip" class="chip chip-starting"></span>
      <span id="header-blocked" class="chip chip-blocked"></span>
      <span id="cost"></span>
      <span id="conv-usage"></span>
    </div>
  </div>
  <div id="transcript"><div id="empty">Loading transcript…</div></div>
  <div id="working" hidden>
    <span id="working-glyph">✳</span>
    <span id="working-text"></span>
  </div>
  <div id="input-area">
    <div id="error-banner" hidden>
      <span id="eb-icon">&#9888;</span>
      <div id="eb-body">
        <div id="eb-title"></div>
        <div id="eb-message"></div>
      </div>
      <button id="eb-dismiss" title="Dismiss">✕</button>
    </div>
    <div id="queued" hidden>
      <span id="queued-icon">&#9203;</span>
      <span id="queued-label"></span>
      <button id="queued-cancel" title="Discard the queued message">✕</button>
    </div>
    <div id="composer">
      <textarea id="input" rows="1" placeholder="Reply to the agent…"></textarea>
      <div id="composer-bar">
        <span id="composer-meta">
          <span id="composer-harness" class="composer-chip"></span>
          <span id="composer-model" class="composer-chip"></span>
          <span id="composer-auth" class="composer-chip"></span>
        </span>
        <span id="send-status"></span>
        <button id="interrupt-send" hidden title="Interrupt the current turn and send the queued message now">Interrupt &amp; send</button>
        <button id="send" title="Send (Enter)">↵</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      // Interpolated from the host's TOOL_IO_MAX_LINES, which is what actually
      // performs the clamp — the two can never disagree about how many lines
      // are on screen, so "N more" is always arithmetic the user can trust.
      const MAX_IO_LINES = ${TOOL_IO_MAX_LINES};
      const headerTitle = document.getElementById('header-title');
      const statusChip = document.getElementById('status-chip');
      const headerBlocked = document.getElementById('header-blocked');
      const costEl = document.getElementById('cost');
      const transcript = document.getElementById('transcript');
      const convUsage = document.getElementById('conv-usage');
      const working = document.getElementById('working');
      const workingText = document.getElementById('working-text');
      const composer = document.getElementById('composer');
      const composerHarness = document.getElementById('composer-harness');
      const composerModel = document.getElementById('composer-model');
      const composerAuth = document.getElementById('composer-auth');
      const input = document.getElementById('input');
      const sendBtn = document.getElementById('send');
      const interruptBtn = document.getElementById('interrupt-send');
      const sendStatus = document.getElementById('send-status');
      const errorBanner = document.getElementById('error-banner');
      const ebTitle = document.getElementById('eb-title');
      const ebMessage = document.getElementById('eb-message');
      const ebDismiss = document.getElementById('eb-dismiss');
      const queuedRow = document.getElementById('queued');
      const queuedLabel = document.getElementById('queued-label');
      const queuedCancel = document.getElementById('queued-cancel');

      // Mirrors STALL_AFTER_MS in views/sessionsTree.logic.ts — the tree and
      // this panel must not disagree about whether a session is stalled.
      const STALL_AFTER_MS = 10 * 60 * 1000;

      let exited = false;
      let busy = false;
      /** Wall-clock ms when the current turn started (0 when idle). */
      let busySince = 0;
      let lastTokensOut;
      /** Latest descriptor — re-read by the 1s ticker so a stall surfaces without a poll. */
      let lastSession;
      /**
       * Text typed while the agent was mid-turn. The daemon takes ONE turn at
       * a time and rejects anything else with a 409, so instead of firing that
       * at the user we hold the message here and flush it the moment the turn
       * ends — or immediately, if they choose to interrupt.
       */
      let queuedText = null;
      let isScrolledUp = false;
      let isSending = false;
      let mode = 'raw';
      let lastUsage;
      // Turns/segments are addressed by stable id (data-turn-id/data-seg-id)
      // and patched in place — a live update never tears the DOM down, so
      // expand/collapse state and text selection survive for free.
      // Pending tool rows whose elapsed-time label ticks independently of
      // any patch: segId -> { startedMs, label, node }.
      const pendingTools = new Map();

      // Grow with the text instead of forcing the user to drag a resize
      // handle, up to the CSS max-height (then the textarea scrolls).
      function autoGrow() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
      }

      // Single source of truth for every composer affordance. Each control
      // reflects what the session can ACTUALLY do right now: no sending to a
      // dead session, no killing an already-dead one, no interrupting an agent
      // that isn't working.
      function refreshComposer() {
        const hasText = Boolean(input.value.trim());
        const live = !exited && !isSending;
        input.disabled = !live;
        sendBtn.disabled = !live || !hasText;
        sendBtn.classList.toggle('has-text', hasText && live);
        // "Interrupt & send" exists to force a message the agent hasn't taken
        // yet — so it appears only when there IS one waiting, not merely
        // whenever the agent is busy.
        interruptBtn.hidden = queuedText === null || exited;
        interruptBtn.disabled = !live;
        composer.classList.toggle('disabled', exited);
        renderQueued();
      }

      function renderQueued() {
        queuedRow.hidden = queuedText === null;
        if (queuedText === null) return;
        // \\s, not \s: this script lives in a template literal, where an
        // unrecognised escape collapses to its own letter — /\s+/ would ship
        // as /s+/ and blank out every "s" in the user's message.
        const oneLine = queuedText.replace(/\\s+/g, ' ').trim();
        const clipped = oneLine.length > 90 ? oneLine.slice(0, 90) + '…' : oneLine;
        queuedLabel.textContent = 'Queued · ' + clipped;
        queuedRow.title = queuedText;
      }

      function showError(title, message) {
        ebTitle.textContent = title;
        ebMessage.textContent = message;
        errorBanner.hidden = false;
      }

      function clearError() {
        errorBanner.hidden = true;
        ebMessage.textContent = '';
      }

      /** Hand the queued text to the agent, optionally cutting its turn short. */
      function flushQueued(interrupt) {
        if (queuedText === null) return;
        const text = queuedText;
        queuedText = null;
        renderQueued();
        vscode.postMessage({ type: interrupt ? 'interruptSend' : 'send', text: text });
        refreshComposer();
      }

      // "Working…" plus how long and how much — the three things a user
      // waiting on a reply actually wants, without expanding anything.
      function refreshWorking() {
        working.hidden = !busy;
        if (!busy) return;
        const now = Date.now();
        const silent = lastSession ? silentForMs(lastSession, now) : undefined;
        const stalled = silent !== undefined && silent > STALL_AFTER_MS;
        // A stalled session must not keep saying "Working…" with a cheerfully
        // climbing counter — that IS the lie the user reported. Name the
        // silence instead and let them judge.
        working.classList.toggle('stalled', stalled);
        if (stalled) {
          workingText.textContent = 'Stalled · no output for ' + formatDuration(silent) +
            ' · the agent may be stuck';
          return;
        }
        const parts = [lastSession && lastSession.blockedOn
          ? 'Waiting on ' + lastSession.blockedOn + '…'
          : 'Working…'];
        if (busySince) parts.push(Math.max(0, Math.round((now - busySince) / 1000)) + 's');
        if (typeof lastTokensOut === 'number') parts.push(lastTokensOut + ' tokens');
        workingText.textContent = parts.join(' · ');
      }

      function applySession(session) {
        lastSession = session;
        updateHeader(session);
        exited = isTerminal(session);
        // A terminal session is never busy, whatever the descriptor says — see
        // isTerminal. Without this a killed session spins the working row forever.
        const nowBusy = !exited && Boolean(session.busy);
        if (nowBusy && !busy) busySince = Date.now();
        if (!nowBusy) busySince = 0;
        const wasBusy = busy;
        busy = nowBusy;
        if (typeof session.tokensOut === 'number') lastTokensOut = session.tokensOut;
        refreshComposer();
        refreshWorking();
        // The turn just ended — the daemon will accept a prompt again, so hand
        // over whatever was typed during it. This is the whole point of the
        // queue: the user types when they think of it, not when the agent is ready.
        if (wasBusy && !nowBusy && !exited && queuedText !== null) flushQueued(false);
      }

      function setSending(sending) {
        isSending = sending;
        refreshComposer();
        sendStatus.textContent = sending ? 'Sending…' : '';
      }

      // A terminal session is over: whatever busy/blockedOn still say about an
      // in-flight turn is stale by definition, so status wins over both.
      function isTerminal(session) {
        return ['exited', 'killed', 'error'].indexOf(session.status) !== -1;
      }

      /** ms since the session last did ANYTHING, while mid-turn. */
      function silentForMs(session, now) {
        if (!session.busy || isTerminal(session)) return undefined;
        const iso = session.lastActivityAt || session.lastOutputAt;
        if (!iso) return undefined;
        const last = Date.parse(iso);
        if (isNaN(last)) return undefined;
        return Math.max(0, now - last);
      }

      function formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) return seconds + 's';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + 'min';
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + 'h';
        return Math.floor(hours / 24) + 'd';
      }

      /**
       * "busy" said nothing: it covered an agent writing a reply and an agent
       * wedged for 20h alike. The three states differ in what the user should
       * DO, so they get three words:
       *   working — generating right now. Wait.
       *   waiting — mid-turn but parked on a background command/sub-agent
       *             (blockedOn). It is not the model that is slow.
       *   stalled — mid-turn and silent past STALL_AFTER_MS. Nothing is
       *             coming; the agent stopped emitting without a turn-end and
       *             the daemon is still awaiting a turn that will never end.
       */
      function computeStatusChip(session, now) {
        if (isTerminal(session)) return 'exited';
        if (session.awaitingInput) return 'awaiting-input';
        if (session.busy) {
          const silent = silentForMs(session, now);
          if (silent !== undefined && silent > STALL_AFTER_MS) return 'stalled';
          return session.blockedOn ? 'waiting' : 'working';
        }
        if (session.status === 'running') return 'running';
        return session.status || 'starting';
      }

      function updateHeader(session) {
        headerTitle.textContent = session.label || session.id || '';
        // What will answer, shown where you type to it — the header no longer
        // repeats any of it. Each chip is omitted when the daemon doesn't
        // report the field (CSS :empty), rather than rendering "undefined".
        composerHarness.textContent = session.adapterSlug || '';
        composerModel.textContent = session.model || '';
        composerAuth.textContent = session.auth ? session.auth.mode : '';

        const chip = computeStatusChip(session, Date.now());
        statusChip.textContent = chip;
        statusChip.className = 'chip chip-' + chip;

        // blockedOn describes an IN-FLIGHT turn, so only claim it while the
        // session is actually taking one. A session killed mid-tool-call keeps
        // a stale blockedOn/busy forever (the daemon clears them in the turn's
        // finally, which never runs for a generator that is never resumed), and
        // rendering that verbatim told the user a dead session was blocked on a
        // command. The chip already reads "exited" in that state — the two must
        // not contradict each other.
        const live = !isTerminal(session) && Boolean(session.busy);
        headerBlocked.textContent = live && session.blockedOn
          ? 'blocked on ' + session.blockedOn + (session.pendingToolCallId ? ' · ' + session.pendingToolCallId.slice(0, 8) : '')
          : '';

        // Cost only. The token counts used to render HERE and again in
        // #conv-usage — the same two numbers, twice in one header — and
        // neither instance was actionable: raw in/out isn't comparable across
        // sessions and isn't a budget. Cost and ctx% are the numbers with a
        // decision attached; the totals stay in the tree tooltip.
        costEl.textContent = typeof session.costUsd === 'number'
          ? '$' + session.costUsd.toFixed(4)
          : '—';
      }

      function appendLines(lines) {
        if (!lines || lines.length === 0) return;
        for (const line of lines) {
          const div = document.createElement('div');
          div.className = 'line line-' + (line.stream || 'stdout');
          // Already ANSI-converted and HTML-escaped on the host (webview/ansi.ts).
          // This was textContent, which rendered the daemon's deliberate ANSI
          // colouring as literal escape-code garbage.
          div.innerHTML = line.html || '';
          transcript.appendChild(div);
        }
        if (!isScrolledUp) {
          transcript.scrollTop = transcript.scrollHeight;
        }
      }

      transcript.addEventListener('scroll', function() {
        const threshold = 20;
        isScrolledUp = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop > threshold;
      });

      // ── Structured timeline rendering ──────────────────────────────
      // All html fields are pre-escaped on the extension host; raw daemon
      // text never reaches innerHTML here, and no content is parsed.

      function el(tag, className, text) {
        const e = document.createElement(tag);
        if (className) e.className = className;
        if (text !== undefined) e.textContent = text;
        return e;
      }

      // Lay out one disclosure row: status on the LEFT, the open/close
      // chevron pushed to the RIGHT and kept faint.
      //
      //   [●|✓|✗]  name .................................  ›
      //
      // Status lives in the GLYPH, never in the container. A failed step used
      // to draw a red border around itself — inside a group that had drawn a
      // red border of its own — so one failure shouted twice in nested boxes
      // while the ✗ that actually says "failed" was uncoloured. Now the cross
      // is red and the box says nothing. Same for a running step: the dot
      // pulses, the border stays quiet.
      //
      // The native <details> triangle is dropped (list-style: none) because it
      // is stuck on the left, where it competes with the status glyph for the
      // one position the eye reads first.
      //
      // Returns the elapsed <span> so a live row can tick it.
      function buildRowSummary(summary, status, label) {
        summary.textContent = '';
        const badge = el('span', 'seg-badge badge-' + status);
        if (status === 'pending') badge.appendChild(el('span', 'seg-dot'));
        else badge.textContent = status === 'error' ? '✗' : '✓';
        summary.appendChild(badge);
        summary.appendChild(el('span', 'seg-label', label));
        const elapsed = el('span', 'seg-elapsed');
        summary.appendChild(elapsed);
        summary.appendChild(el('span', 'seg-chev', '›'));
        return elapsed;
      }

      // One side (input/output) of a tool card: a clamped <pre> that opens
      // the FULL value in a read-only editor tab when clicked.
      //
      // The block is always clickable, not only when clamped: the clamped
      // flag means "lines were dropped", which the host can prove — but a
      // single line 900 chars wide is clipped by CSS and the host has no way
      // to know it. Clicking anywhere therefore always works; the explicit
      // link only appears when we can honestly say how much is hidden.
      function appendToolIo(node, seg, field, className, html, clamped, lines) {
        const pre = el('pre', className + (clamped ? ' tool-io-clamped' : ''));
        pre.innerHTML = html;
        pre.title = 'Click to open the full ' + field + ' in an editor';
        const open = () => vscode.postMessage({ type: 'openToolIo', segmentId: seg.id, field: field });
        pre.addEventListener('click', open);
        node.appendChild(pre);
        if (clamped) {
          const hidden = lines - MAX_IO_LINES;
          const link = el('span', 'tool-io-open',
            '⤢ open ' + lines + ' lines (' + hidden + ' more)');
          link.addEventListener('click', open);
          node.appendChild(link);
        }
      }

      // Cheap content-equality check for a segment: segments are plain,
      // host-built data (ids/strings/numbers) rebuilt fresh on every present,
      // so JSON.stringify is a safe, fast stand-in for a recursive deep-equal
      // here — same reasoning as conversationPatch.ts on the host side.
      function segSig(seg) {
        return JSON.stringify(seg);
      }

      // The addressable shell for a segment kind: for 'reasoning'/'tool' this
      // is a <details> element, so it's built ONCE and then repainted in
      // place — never replaced — which is what keeps <details open> (and any
      // text selection inside it) alive across live updates.
      function buildSegmentShell(seg) {
        if (seg.kind === 'reasoning' || seg.kind === 'tool' || seg.kind === 'activity') {
          const det = document.createElement('details');
          det.appendChild(document.createElement('summary'));
          return det;
        }
        return el('div');
      }

      function paintElapsed(entry) {
        const seconds = Math.max(0, Math.round((Date.now() - entry.startedMs) / 1000));
        const stillRunning = seconds >= 10;
        entry.label.textContent = (stillRunning ? 'still running · ' : 'running · ') + seconds + 's';
        entry.node.classList.toggle('tool-still-running', stillRunning);
      }

      // Paint a segment's content into an EXISTING shell node. Called both
      // right after buildSegmentShell (new segment) and whenever an existing
      // segment's signature changes (updated segment) — the shell itself is
      // never touched, only its innards.
      function paintSegment(node, seg) {
        switch (seg.kind) {
          case 'user':
          case 'assistant-text':
            node.className = 'seg text';
            node.innerHTML = seg.html || '';
            return;
          case 'reasoning': {
            node.className = 'seg reasoning';
            node.querySelector(':scope > summary').textContent = 'Reasoning';
            let body = node.querySelector(':scope > .reasoning-body');
            if (!body) {
              body = el('div', 'reasoning-body');
              node.appendChild(body);
            }
            body.innerHTML = seg.html || '';
            return;
          }
          case 'tool': {
            node.className = 'seg tool tool-' + seg.status;
            const summary = node.querySelector(':scope > summary');
            const elapsed = buildRowSummary(summary, seg.status, seg.toolName || 'tool');
            // Rebuild everything after <summary> — cheap (a handful of
            // nodes) and simpler than diffing input/pending/output fields
            // individually; the shell (and its open state) is untouched.
            while (summary.nextSibling) node.removeChild(summary.nextSibling);
            if (seg.argsText !== undefined) {
              node.appendChild(el('div', 'tool-field-label', 'input'));
              appendToolIo(node, seg, 'input', 'tool-args', seg.argsText, seg.argsClamped, seg.argsLines);
            }
            if (seg.status === 'pending') {
              // The ticker writes into the SUMMARY, not a row in the body:
              // a running step is the one you most need to read while the
              // card is collapsed, and the body is exactly what's hidden.
              const startedMs = seg.ts ? Date.parse(seg.ts) : NaN;
              const entry = { startedMs: isNaN(startedMs) ? Date.now() : startedMs, label: elapsed, node };
              pendingTools.set(seg.id, entry);
              paintElapsed(entry);
            } else {
              pendingTools.delete(seg.id);
              node.classList.remove('tool-still-running');
            }
            if (seg.resultText !== undefined) {
              node.appendChild(el('div', 'tool-field-label', 'output'));
              appendToolIo(node, seg, 'output', 'tool-result', seg.resultText, seg.resultClamped, seg.resultLines);
            }
            return;
          }
          case 'plan': {
            node.className = 'seg plan';
            node.innerHTML = '';
            node.appendChild(el('div', 'plan-head', 'Plan ' + seg.done + '/' + seg.total));
            const ul = el('ul', 'plan-list');
            for (const entry of seg.entries || []) {
              const mark = entry.status === 'completed' ? '☑ '
                : entry.status === 'in_progress' ? '▸ ' : '☐ ';
              ul.appendChild(el('li', 'plan-' + entry.status, mark + entry.content));
            }
            node.appendChild(ul);
            return;
          }
          case 'agent-question': {
            node.className = 'seg question';
            node.innerHTML = '';
            node.appendChild(el('div', undefined, 'Awaiting your decision'));
            if (seg.options && seg.options.length) {
              const ul = el('ul');
              for (const opt of seg.options) ul.appendChild(el('li', undefined, opt));
              node.appendChild(ul);
            }
            return;
          }
          case 'error':
            node.className = 'seg error';
            node.innerHTML = seg.text || '';
            return;
          case 'activity': {
            // Collapsed by default (the open attribute is never set): a fold
            // that springs open on every new step would defeat its own purpose.
            // The <details> shell is never replaced, so once the user opens the
            // tree it STAYS open as steps stream in underneath.
            node.className = 'seg activity activity-' + seg.status;
            const summary = node.querySelector(':scope > summary');
            // Same row shape as a tool card — a group is a step that happens
            // to contain steps, so it reads with the same grammar.
            const elapsed = buildRowSummary(summary, seg.status, seg.summary || '');
            let kids = node.querySelector(':scope > .act-children');
            if (!kids) {
              kids = el('div', 'act-children');
              node.appendChild(kids);
            }
            // Recursive reconcile — a child whose signature didn't change is
            // left untouched, so its own expand state survives too.
            reconcileSegments(kids, seg.children || []);
            if (seg.status === 'pending') {
              const startedMs = seg.pendingSince ? Date.parse(seg.pendingSince) : NaN;
              const entry = { startedMs: isNaN(startedMs) ? Date.now() : startedMs, label: elapsed, node };
              pendingTools.set(seg.id, entry);
              paintElapsed(entry);
            } else {
              pendingTools.delete(seg.id);
              node.classList.remove('tool-still-running');
            }
            return;
          }
        }
      }

      // Ticks pending tools' elapsed labels independently of any patch —
      // "started but no answer yet" must keep moving even on a quiet poll.
      setInterval(() => {
        for (const [segId, entry] of pendingTools) {
          if (!entry.node.isConnected) { pendingTools.delete(segId); continue; }
          paintElapsed(entry);
        }
        // The working row's elapsed must keep moving on a quiet poll too — a
        // frozen counter is exactly what "is it stuck?" looks like.
        refreshWorking();
      }, 1000);

      // Marks runs of consecutive tool segments so CSS can merge them into
      // one compact group instead of N separately-bordered cards.
      function markToolRuns(bubble) {
        const children = Array.prototype.slice.call(bubble.querySelectorAll(':scope > [data-seg-id]'));
        children.forEach((node, i) => {
          node.classList.remove('tool-run-start', 'tool-run-mid', 'tool-run-end');
          if (!node.classList.contains('tool')) return;
          const prevIsTool = i > 0 && children[i - 1].classList.contains('tool');
          const nextIsTool = i < children.length - 1 && children[i + 1].classList.contains('tool');
          if (prevIsTool && nextIsTool) node.classList.add('tool-run-mid');
          else if (prevIsTool) node.classList.add('tool-run-end');
          else if (nextIsTool) node.classList.add('tool-run-start');
        });
      }

      // Reconcile a turn's segment nodes against the incoming segment list:
      // upsert changed/new ones, remove dropped ones, and — critically —
      // never touch a node whose signature didn't change, which is what
      // keeps <details open> and any in-progress text selection alive.
      function reconcileSegments(bubble, segments) {
        const existing = {};
        bubble.querySelectorAll(':scope > [data-seg-id]').forEach(node => {
          existing[node.dataset.segId] = node;
        });
        const seen = {};
        let anchor = null;
        for (const seg of segments) {
          seen[seg.id] = true;
          const sig = segSig(seg);
          let node = existing[seg.id];
          if (!node) {
            node = buildSegmentShell(seg);
            node.dataset.segId = seg.id;
            paintSegment(node, seg);
            node.dataset.sig = sig;
          } else if (node.dataset.sig !== sig) {
            paintSegment(node, seg);
            node.dataset.sig = sig;
          }
          const inPlace = anchor ? anchor.nextElementSibling === node : bubble.firstElementChild === node;
          if (!inPlace) {
            if (anchor) anchor.after(node);
            else bubble.insertBefore(node, bubble.firstChild);
          }
          anchor = node;
        }
        for (const id in existing) {
          if (!seen[id]) existing[id].remove();
        }
        markToolRuns(bubble);
      }

      // Turn ids are "turn-<seq>" (see reduceConversation in conversation.ts)
      // — host-assigned structural metadata, not daemon content — so the
      // numeric suffix is a safe, cheap ordering key for placing a
      // late-arriving or out-of-order turn without needing the full
      // timeline order in every patch.
      function turnSeq(turnId) {
        const n = Number(String(turnId).slice(String(turnId).lastIndexOf('-') + 1));
        return isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
      }

      function insertTurnInOrder(node) {
        const seq = turnSeq(node.dataset.turnId);
        const siblings = transcript.querySelectorAll('.turn[data-turn-id]');
        for (const sibling of siblings) {
          if (turnSeq(sibling.dataset.turnId) > seq) {
            transcript.insertBefore(node, sibling);
            return;
          }
        }
        transcript.appendChild(node);
      }

      function currentTurnNodes() {
        const nodes = {};
        transcript.querySelectorAll('.turn[data-turn-id]').forEach(node => {
          nodes[node.dataset.turnId] = node;
        });
        return nodes;
      }

      function upsertTurn(turn, nodes) {
        const existing = nodes[turn.id];
        if (existing) {
          reconcileSegments(existing.querySelector(':scope > .bubble'), turn.segments || []);
          return;
        }
        const node = el('div', 'turn turn-' + turn.role);
        node.dataset.turnId = turn.id;
        // "You" labels a user turn; an unlabeled bubble (transparent
        // background, see CSS) reads as the assistant without repeating it
        // on every single turn.
        if (turn.role === 'user') node.appendChild(el('div', 'role', 'You'));
        const bubble = el('div', 'bubble');
        node.appendChild(bubble);
        reconcileSegments(bubble, turn.segments || []);
        insertTurnInOrder(node);
        nodes[turn.id] = node;
      }

      function syncEmptyState() {
        const hasTurns = transcript.querySelector('.turn[data-turn-id]') !== null;
        const emptyNode = document.getElementById('empty');
        if (hasTurns) {
          if (emptyNode) emptyNode.remove();
        } else if (!emptyNode) {
          const e = el('div', undefined, 'No messages yet.');
          e.id = 'empty';
          transcript.appendChild(e);
        }
      }

      function renderUsage(usage) {
        if (!usage) { convUsage.textContent = ''; convUsage.title = ''; return; }
        const parts = [];
        // Context fill only — "ctx 206115/1000000" was two numbers the reader
        // had to divide, and the in/out totals that used to trail it merely
        // repeated what the cost element already showed, in the same header.
        const used = typeof usage.contextUsed === 'number' ? usage.contextUsed : usage.used;
        const size = typeof usage.contextSize === 'number' ? usage.contextSize : usage.size;
        if (typeof used === 'number' && typeof size === 'number' && size > 0) {
          parts.push('ctx ' + Math.round((used / size) * 100) + '%');
          convUsage.title = 'context ' + used + ' / ' + size;
        } else {
          convUsage.title = '';
        }
        convUsage.textContent = parts.join(' · ');
      }

      // Full resync — used by 'init' (and a hypothetical future 'conversation'
      // full-resync message). Everything after this flows as 'patch'.
      function renderFullConversation(conv) {
        const atBottom = !isScrolledUp;
        transcript.innerHTML = '';
        pendingTools.clear();
        const nodes = {};
        if (conv && conv.turns) {
          for (const turn of conv.turns) upsertTurn(turn, nodes);
        }
        syncEmptyState();
        lastUsage = conv && conv.usage;
        renderUsage(lastUsage);
        if (atBottom) transcript.scrollTop = transcript.scrollHeight;
      }

      // Live update — reconciles in place instead of rebuilding the timeline.
      function applyPatch(patch) {
        const atBottom = !isScrolledUp;
        const nodes = currentTurnNodes();
        for (const id of patch.removeTurnIds || []) {
          const node = nodes[id];
          if (node) { node.remove(); delete nodes[id]; }
        }
        for (const turn of patch.upsertTurns || []) upsertTurn(turn, nodes);
        syncEmptyState();
        if (patch.usage !== undefined) {
          lastUsage = patch.usage;
          renderUsage(lastUsage);
        }
        if (atBottom) transcript.scrollTop = transcript.scrollHeight;
      }

      function send(interrupt) {
        const text = input.value;
        if (!text || !text.trim()) return;
        const trimmed = text.trim();
        input.value = '';
        autoGrow();
        clearError();
        // Mid-turn and not explicitly interrupting: hold it rather than POST a
        // prompt the daemon will refuse with a 409. It goes out on turn-end.
        if (busy && !interrupt) {
          queuedText = trimmed;
          refreshComposer();
          return;
        }
        vscode.postMessage({ type: interrupt ? 'interruptSend' : 'send', text: trimmed });
        refreshComposer();
      }

      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send(false);
        }
      });

      input.addEventListener('input', function() {
        autoGrow();
        refreshComposer();
      });

      sendBtn.addEventListener('click', function() { send(false); });
      // Interrupt only ever acts on the queued message — it's the only thing
      // waiting, and it's what the button offers to stop waiting for.
      interruptBtn.addEventListener('click', function() { flushQueued(true); });
      queuedCancel.addEventListener('click', function() {
        queuedText = null;
        refreshComposer();
      });
      ebDismiss.addEventListener('click', clearError);

      window.addEventListener('message', function(e) {
        const msg = e.data;
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'init':
            mode = msg.mode || 'raw';
            isScrolledUp = false;
            if (mode === 'structured') {
              renderFullConversation(msg.conversation);
            } else {
              transcript.innerHTML = msg.initialHtml || '<div id="empty">No transcript available.</div>';
              transcript.scrollTop = transcript.scrollHeight;
            }
            applySession(msg.session);
            break;
          case 'conversation':
            renderFullConversation(msg.conversation);
            break;
          case 'patch':
            applyPatch(msg);
            break;
          case 'sessionUpdate':
            applySession(msg.session);
            break;
          case 'lines':
            if (mode !== 'structured') appendLines(msg.lines);
            break;
          case 'sending':
            setSending(true);
            break;
          case 'sendAck':
            setSending(false);
            break;
          case 'sendError':
            setSending(false);
            if (msg.kind === 'busy') {
              // Lost the race: the turn started between our busy check and the
              // POST. Not an error — re-queue and let turn-end flush it, which
              // is exactly what would have happened had we seen busy in time.
              queuedText = msg.text || queuedText;
              refreshComposer();
              break;
            }
            showError(msg.title || 'Send failed', msg.message || '');
            break;
        }
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`
}
