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
import {
  ATTACHMENT_COUNT_CAP,
  MAX_ATTACHMENT_BYTES,
  WARN_ATTACHMENT_BYTES,
  parseUriList,
} from "./attachments.logic.js"
import { mentionQueryAt } from "./mentions.logic.js"
import { recallHistory, pushHistoryEntry } from "./history.logic.js"
import { accessIdentity, contextGauge, harnessGlyph } from "./panelChrome.logic.js"
import { TOOL_IO_MAX_LINES } from "./conversation.js"
import type { SeenTracker } from "../services/seen.js"
import { formatTitle } from "./transcript.logic.js"
import { isWebviewMessage, type ExtMessage, type WebviewMessage } from "./protocol.js"
import { TranscriptPanelController } from "./transcriptPanelController.js"
import { runChangeModelFlow } from "../commands/changeModel.js"

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
          // FIX A: the tab caption was set ONCE at createWebviewPanel and never
          // reassigned, so a tab opened before the title derived (or before a
          // rename) stayed frozen on the raw session id. Reassign it here on
          // every store change — cheap, and idempotent when the name is
          // unchanged — so the tab tracks the derived title and live renames.
          panel.title = formatTitle(updated)
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
            await handleWebviewMessage(raw, panel, controller, outputDocs, client)
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

export async function handleWebviewMessage(
  msg: WebviewMessage,
  panel: vscode.WebviewPanel,
  controller: TranscriptPanelController,
  outputDocs: OutputDocuments,
  client: DaemonClient,
): Promise<void> {
  switch (msg.type) {
    case "ready":
      await controller.onReady()
      return
    case "changeModel":
      await runChangeModelFlow(controller, client)
      return
    case "send":
      await controller.onSend(msg.text, false)
      return
    case "interruptSend":
      await controller.onSend(msg.text, true)
      return
    case "stop":
      await controller.onStop()
      return
    case "restart":
      await controller.onRestart()
      return
    case "openTerminal":
      await vscode.commands.executeCommand("agentproto.openTerminal", controller.session.id)
      return
    case "setView":
      await controller.onSetView(msg.view)
      panel.reveal(vscode.ViewColumn.One, false)
      return
    case "rename":
      await controller.onRename(msg.name)
      return
    case "attachImage":
      await controller.onAttachImage(msg.bytes, msg.mime)
      return
    case "attachFile":
      await controller.onAttachFile(msg.bytes, msg.mime, msg.name)
      return
    case "requestMentions":
      await controller.onRequestMentions(msg.query)
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

  // Two pure helpers must run INSIDE the webview (caret detection for @mentions,
  // uri-list parsing for drops). The webview script is a string with no import
  // mechanism, so rather than hand-copy them — and risk a copy that silently
  // drifts from the tested source — we inject them BY VALUE from the very
  // functions the logic-module unit tests pin. Safe because both are
  // self-contained (no module-scope references) and the build isn't minified,
  // so `.toString()` yields a clean, named, hoistable declaration.
  const injectedHelpers = [
    mentionQueryAt,
    parseUriList,
    recallHistory,
    pushHistoryEntry,
    harnessGlyph,
    accessIdentity,
    contextGauge,
  ]
    .map(fn => fn.toString())
    .join("\n      ")

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
    /* One row: the conversation's name on the left, two detail buttons on
       the right. Everything this used to carry (status chip, blocked-on
       chip, token totals) either repeats the tab icon or is a number you
       consult in a popover, not one you monitor in a strip. */
    #header {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, rgba(128,128,128,0.3)));
      background-color: var(--vscode-sideBar-background);
    }
    #header-title {
      font-weight: 600;
      font-size: 1.1em;
      color: var(--vscode-sideBarTitle-foreground);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      /* Click-to-edit (FIX B): the title doubles as a rename affordance. */
      cursor: text;
    }
    #header-title:hover { color: var(--vscode-foreground); }
    /* The inline rename box that replaces the title text while editing —
       sized to fill the same slot so the header doesn't reflow. */
    #header-title input {
      width: 100%;
      font: inherit;
      font-weight: 600;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-focusBorder, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 1px 4px;
    }
    #header-actions {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .header-action { position: relative; }
    .header-btn { font-size: 0.85em; }
    .header-btn:empty { display: none; }
    /* The harness/adapter mark, sitting left of the session name so a glance at
       any transcript tab says which agent answers there. A quiet glyph, not a
       chip — colour comes from the surrounding title row. Empty (no adapter
       reported yet) collapses to nothing. */
    #header-icon {
      flex: 0 0 auto;
      font-size: 1.05em;
      line-height: 1;
      color: var(--vscode-descriptionForeground);
    }
    #header-icon:empty { display: none; }
    /* A single Terminal button that opens the terminal view (FIX 2) — replaces
       the old Conversation⇄Terminal segmented control, which was too heavy for
       what is a one-way jump to the raw view. Reuses the openTerminal command.
       Hidden via [hidden] when the session has no terminal representation. */
    .term-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.8em;
      padding: 2px 8px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 5px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
    }
    .term-btn[hidden] { display: none; }
    .term-btn:hover:not(:disabled) {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
    }
    .term-glyph {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
      opacity: 0.8;
    }
    /* Context-window fill as a compact ring gauge (FIX 5) — replaces the plain
       "ctx N%" text with a 14px ring plus a small percent, so it reads at a
       glance and costs less horizontal space. The ring's colour tracks the
       fill level (calm → warning). Still the button that opens the raw-counts
       popover. */
    .ctx-gauge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 4px;
    }
    .ctx-gauge[hidden] { display: none; }
    .ctx-ring { flex: 0 0 auto; }
    .ctx-track { stroke: var(--vscode-panel-border, rgba(128,128,128,0.35)); }
    .ctx-arc { stroke: var(--vscode-charts-green, #4caf50); transition: stroke-dasharray 0.2s ease; }
    .ctx-arc.mid { stroke: var(--vscode-charts-yellow, #d7a600); }
    .ctx-arc.high { stroke: var(--vscode-charts-red, #e51400); }
    .ctx-pct {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
    }
    /* A webview has no VS Code popover API — this is our own
       absolutely-positioned element, anchored to its button so it never
       reflows the transcript underneath it. */
    .popover {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      z-index: 30;
      min-width: 200px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      font-size: 0.85em;
    }
    .popover[hidden] { display: none; }
    .popover-row {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      padding: 2px 0;
    }
    .popover-label { color: var(--vscode-descriptionForeground); }
    /* Delayed and low-key on purpose — see BLOCKED_NOTE_DELAY_MS in the
       script. Sits in the conversation body, next to the tool call it
       describes, not the header: the tab icon already carries the states
       that deserve a permanent glyph. */
    #blocked-note {
      flex: 0 0 auto;
      padding: 4px 14px 0;
      font-size: 0.85em;
      color: var(--vscode-editorWarning-foreground);
    }
    #blocked-note[hidden] { display: none; }
    /* Resume-chain history — a restarted session's ancestor transcripts,
       rendered ONCE at init as the FIRST content INSIDE #transcript (see the
       'init' handler + paintResumeChain), not a separate scroll pane above
       it: one continuous conversation, oldest ancestor turn to newest live
       one, governed by #transcript's single scroll region. Empty (no
       resumedFrom) collapses to nothing via :empty — no border, no gap. */
    #resume-history {
      padding-bottom: 6px;
      margin-bottom: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    #resume-history:empty { display: none; padding: 0; margin: 0; border: none; }
    .resume-divider {
      text-align: center;
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground);
      margin: 10px 0;
      opacity: 0.8;
    }
    .resume-unavailable {
      font-size: 0.85em;
      font-style: italic;
      color: var(--vscode-descriptionForeground);
      padding: 4px 0 10px;
    }
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
      position: relative;
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
    /* Drop affordance: the composer is the drop target, so it lights up while a
       file is dragged over the panel. */
    #composer.drag-over { border-color: var(--vscode-focusBorder); border-style: dashed; }
    /* ── Attachment chips ─────────────────────────────────────────────
       A pasted/dragged/mentioned path becomes a removable chip here, not
       raw text in the box — the path still rides along in the sent prompt
       (composePrompt appends it), this is just the editable pre-send view. */
    #composer-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    #composer-attachments[hidden] { display: none; }
    .attach-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 260px;
      padding: 2px 4px 2px 8px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.35)));
      border-radius: 10px;
      background: var(--vscode-badge-background, rgba(128,128,128,0.18));
      color: var(--vscode-badge-foreground, var(--vscode-editor-foreground));
      font-size: 0.85em;
    }
    .attach-chip-label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .attach-chip-remove {
      flex: 0 0 auto;
      cursor: pointer;
      opacity: 0.6;
      padding: 0 3px;
      border-radius: 4px;
      line-height: 1;
    }
    .attach-chip-remove:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.25)); }
    /* ── @mention popup ───────────────────────────────────────────────
       Floats above the composer; the webview renders it itself (a VS Code
       CompletionProvider isn't available inside a webview). */
    #mention-popup {
      position: absolute;
      left: 8px;
      right: 8px;
      bottom: calc(100% + 4px);
      max-height: 220px;
      overflow-y: auto;
      z-index: 5;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
      border-radius: 6px;
      background: var(--vscode-editorSuggestWidget-background, var(--vscode-input-background));
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    }
    #mention-popup[hidden] { display: none; }
    .mention-item {
      padding: 4px 10px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
    }
    .mention-item.active,
    .mention-item:hover {
      background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground));
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-editor-foreground));
    }
    .mention-empty {
      padding: 4px 10px;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
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
    /* The model chip is the one clickable chip (click → switch model) — reset
       the generic button rule's chrome so it still reads as plain chip text,
       only gaining an underline + link color on hover as the click affordance. */
    .composer-chip-btn {
      padding: 0;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: inherit;
      font: inherit;
    }
    .composer-chip-btn:hover:not(:disabled) {
      background: transparent;
      color: var(--vscode-textLink-foreground, var(--vscode-editor-foreground));
      text-decoration: underline;
    }
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
    /* Destructive-but-not-alarming: it abandons a turn, not the session, so
       this stops short of the errorForeground/errorBackground pair #kill's
       hover uses. */
    #stop {
      flex: 0 0 auto;
      min-width: 26px;
      font-size: 0.85em;
      line-height: 1;
      padding: 4px 8px;
      background: var(--vscode-inputValidation-warningBackground, rgba(128,128,128,0.2));
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-editor-foreground));
    }
    #stop:hover:not(:disabled) {
      background: var(--vscode-inputValidation-warningBorder, var(--vscode-toolbar-hoverBackground));
    }
    /* Shown only once the session has exited, beside the now-disabled input
       (see refreshComposer) — a session that has exited has exactly one
       useful action left, so it earns the button's primary styling, same
       treatment as #send.has-text. */
    #restart-btn {
      flex: 0 0 auto;
      font-size: 0.85em;
      line-height: 1;
      padding: 4px 8px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #restart-btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
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
    <span id="header-icon" title="" aria-hidden="true"></span>
    <div id="header-title" title="Click to rename this session"></div>
    <div id="header-actions">
      <button id="open-terminal-btn" class="header-action term-btn" type="button" title="Open the terminal view for this session" hidden>
        <span class="term-glyph" aria-hidden="true">&gt;_</span>Terminal
      </button>
      <div class="header-action">
        <button id="cost-btn" class="header-btn" type="button" aria-haspopup="true"></button>
        <div id="cost-popover" class="popover" hidden>
          <div class="popover-row"><span class="popover-label">Tokens in</span><span id="popover-tokens-in"></span></div>
          <div class="popover-row"><span class="popover-label">Tokens out</span><span id="popover-tokens-out"></span></div>
          <div class="popover-row"><span class="popover-label">Model</span><span id="popover-model"></span></div>
          <div class="popover-row"><span class="popover-label">Harness</span><span id="popover-harness"></span></div>
          <div class="popover-row"><span class="popover-label">Access</span><span id="popover-auth"></span></div>
        </div>
      </div>
      <div class="header-action">
        <button id="context-btn" class="header-btn ctx-gauge" type="button" aria-haspopup="true" title="Context window usage" hidden>
          <svg class="ctx-ring" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle class="ctx-track" cx="8" cy="8" r="6" fill="none" stroke-width="2"></circle>
            <circle id="ctx-arc" class="ctx-arc" cx="8" cy="8" r="6" fill="none" stroke-width="2" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="0 100"></circle>
          </svg>
          <span id="ctx-pct" class="ctx-pct"></span>
        </button>
        <div id="context-popover" class="popover" hidden>
          <div class="popover-row"><span class="popover-label">Used</span><span id="popover-context-used"></span></div>
          <div class="popover-row"><span class="popover-label">Size</span><span id="popover-context-size"></span></div>
        </div>
      </div>
    </div>
  </div>
  <div id="transcript"><div id="empty">Loading transcript…</div></div>
  <div id="blocked-note" hidden></div>
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
      <div id="mention-popup" hidden></div>
      <div id="composer-attachments" hidden></div>
      <textarea id="input" rows="1" placeholder="Reply to the agent… (paste, drop, or @-mention a file)"></textarea>
      <div id="composer-bar">
        <span id="composer-meta">
          <span id="composer-harness" class="composer-chip"></span>
          <button id="composer-model" class="composer-chip composer-chip-btn" type="button" title="Switch model"></button>
        </span>
        <span id="send-status"></span>
        <button id="interrupt-send" hidden title="Interrupt the current turn and send the queued message now">Interrupt &amp; send</button>
        <button id="restart-btn" hidden title="Restart this session — resumes the conversation in a new session">↻ Restart</button>
        <button id="send" title="Send (Enter)">↵</button>
        <button id="stop" hidden title="Stop the current turn">■</button>
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
      // Attachment caps — interpolated from attachments.logic.ts so the webview
      // and the host can never disagree about the limits (same reasoning as
      // MAX_IO_LINES above).
      const MAX_ATTACHMENT_BYTES = ${MAX_ATTACHMENT_BYTES};
      const WARN_ATTACHMENT_BYTES = ${WARN_ATTACHMENT_BYTES};
      const ATTACHMENT_COUNT_CAP = ${ATTACHMENT_COUNT_CAP};
      // Injected by value from the tested logic modules — see buildHtml.
      ${injectedHelpers}
      const headerTitle = document.getElementById('header-title');
      const headerIcon = document.getElementById('header-icon');
      const openTerminalBtn = document.getElementById('open-terminal-btn');
      const costBtn = document.getElementById('cost-btn');
      const costPopover = document.getElementById('cost-popover');
      const popoverTokensIn = document.getElementById('popover-tokens-in');
      const popoverTokensOut = document.getElementById('popover-tokens-out');
      const popoverModel = document.getElementById('popover-model');
      const popoverHarness = document.getElementById('popover-harness');
      const popoverAuth = document.getElementById('popover-auth');
      const contextBtn = document.getElementById('context-btn');
      const contextPopover = document.getElementById('context-popover');
      const ctxArc = document.getElementById('ctx-arc');
      const ctxPct = document.getElementById('ctx-pct');
      const popoverContextUsed = document.getElementById('popover-context-used');
      const popoverContextSize = document.getElementById('popover-context-size');
      const blockedNote = document.getElementById('blocked-note');
      const transcript = document.getElementById('transcript');
      const working = document.getElementById('working');
      const workingText = document.getElementById('working-text');
      const composer = document.getElementById('composer');
      const composerHarness = document.getElementById('composer-harness');
      const composerModel = document.getElementById('composer-model');
      const input = document.getElementById('input');
      const sendBtn = document.getElementById('send');
      const stopBtn = document.getElementById('stop');
      const interruptBtn = document.getElementById('interrupt-send');
      const restartBtn = document.getElementById('restart-btn');
      const sendStatus = document.getElementById('send-status');
      const errorBanner = document.getElementById('error-banner');
      const ebTitle = document.getElementById('eb-title');
      const ebMessage = document.getElementById('eb-message');
      const ebDismiss = document.getElementById('eb-dismiss');
      const queuedRow = document.getElementById('queued');
      const queuedLabel = document.getElementById('queued-label');
      const queuedCancel = document.getElementById('queued-cancel');
      const attachmentsRow = document.getElementById('composer-attachments');
      const mentionPopup = document.getElementById('mention-popup');

      // Mirrors STALL_AFTER_MS in views/sessionsTree.logic.ts — the tree and
      // this panel must not disagree about whether a session is stalled.
      const STALL_AFTER_MS = 10 * 60 * 1000;
      // A different, much shorter signal — not a replacement for the stall
      // check above. Almost every blocked-on-tool note clears in a second or
      // two, so showing it instantly just flashes; only a block that outlasts
      // this delay is worth a note in the conversation body.
      const BLOCKED_NOTE_DELAY_MS = 20 * 1000;

      let exited = false;
      let busy = false;
      /** Wall-clock ms when the current turn's blockedOn note started being
       *  true (0 when not currently blocked) — see refreshBlockedNote. */
      let blockedSince = 0;
      /** Wall-clock ms when the current turn started (0 when idle). */
      let busySince = 0;
      let lastTokensOut;
      /** Latest descriptor — re-read by the 1s ticker so a stall surfaces without a poll. */
      let lastSession;
      /** True while the in-place header rename box is open — see beginTitleEdit.
       *  Guards updateHeader from wiping the input on a mid-edit sessionUpdate. */
      let isEditingTitle = false;
      /**
       * Text typed while the agent was mid-turn. The daemon takes ONE turn at
       * a time and rejects anything else with a 409, so instead of firing that
       * at the user we hold the message here and flush it the moment the turn
       * ends — or immediately, if they choose to interrupt.
       */
      let queuedText = null;
      // Prompt history for Up/Down (history.logic.ts). Seeded from init's
      // history field (raw user-prompt texts, oldest to newest); extended
      // locally by send() from then on.
      let historyState = { entries: [], index: null, draft: '' };
      // Pending attachments: { path, label }. Their paths are appended to the
      // prompt by composePrompt() at send time, so the queue keeps storing a
      // plain string and nothing here has to survive a mid-turn queue.
      let attachments = [];
      // Active @mention: { start, end, query, items, active } or null. start/end
      // bracket the @token in the textarea so a selection replaces exactly it;
      // active is the index of the highlighted item.
      let mention = null;
      let isScrolledUp = false;
      let isSending = false;
      /** True from the Stop click until the turn actually settles (busy goes
       *  false) or a stopError comes back — guards against a double-click
       *  firing a second interrupt at an already-cancelling turn. */
      let isStopping = false;
      let mode = 'raw';
      // Cached copy of the current session's resume chain (oldest-first, see
      // protocol.ts's init.resumeChain doc) so a full-transcript reset
      // (clearTranscript, below) can repaint the SAME static ancestor block
      // it would otherwise wipe — #resume-history now lives INSIDE
      // #transcript (one continuous scroll region), so a blind
      // transcript.innerHTML reset erases it without this.
      let lastResumeChain = null;
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
        // An attachment alone is sendable — "here, look at this" with no words.
        const hasText = Boolean(input.value.trim()) || attachments.length > 0;
        const live = !exited && !isSending;
        input.disabled = !live;
        sendBtn.disabled = !live || !hasText;
        sendBtn.classList.toggle('has-text', hasText && live);
        // Send/Stop are mutually exclusive: mid-turn, there is nothing to
        // send (Enter queues instead — see send()), so the button that
        // fires is Stop, not Send.
        sendBtn.hidden = busy && !exited;
        stopBtn.hidden = !busy || exited;
        stopBtn.disabled = isStopping;
        // "Interrupt & send" exists to force a message the agent hasn't taken
        // yet — so it appears only when there IS one waiting, not merely
        // whenever the agent is busy.
        interruptBtn.hidden = queuedText === null || exited;
        interruptBtn.disabled = !live;
        // The one useful action left once a session has exited — shown
        // beside the now-disabled input rather than replacing it, so the
        // last message typed (if any) stays visible instead of vanishing.
        restartBtn.hidden = !exited;
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

      // "busy" said nothing: it covered an agent writing a reply and an agent
      // wedged for 20h alike. working/waiting/stalled differ in what the user
      // should DO, so they get three words — this is the only remaining
      // renderer of that vocabulary now that the header's status chip is gone:
      //   working — generating right now. Wait.
      //   waiting — mid-turn but parked on a background command/sub-agent
      //             (blockedOn). It is not the model that is slow.
      //   stalled — mid-turn and silent past STALL_AFTER_MS. Nothing is
      //             coming; the agent stopped emitting without a turn-end and
      //             the daemon is still awaiting a turn that will never end.
      // Plus how long and how much — the three things a user waiting on a
      // reply actually wants, without expanding anything.
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
        // The turn is over (however it ended) — Stop's job is done.
        if (wasBusy && !nowBusy) isStopping = false;
        if (typeof session.tokensOut === 'number') lastTokensOut = session.tokensOut;
        refreshComposer();
        refreshWorking();
        refreshBlockedNote();
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

      // blockedOn describes an IN-FLIGHT turn, so only claim it while the
      // session is actually taking one. A session killed mid-tool-call keeps
      // a stale blockedOn/busy forever (the daemon clears them in the turn's
      // finally, which never runs for a generator that is never resumed), and
      // rendering that verbatim told the user a dead session was blocked on a
      // command. isTerminal already governs busy/exited elsewhere — this must
      // not contradict it.
      function refreshBlockedNote() {
        const session = lastSession;
        const live = Boolean(session) && !isTerminal(session) && Boolean(session.busy) && Boolean(session.blockedOn);
        if (!live) {
          blockedSince = 0;
          blockedNote.hidden = true;
          blockedNote.textContent = '';
          return;
        }
        if (!blockedSince) blockedSince = Date.now();
        // Almost every block clears in a second or two — showing it instantly
        // just flashes and means nothing. Only a block that outlasts the
        // delay is worth a note, and it clears the instant live goes false.
        if (Date.now() - blockedSince < BLOCKED_NOTE_DELAY_MS) {
          blockedNote.hidden = true;
          blockedNote.textContent = '';
          return;
        }
        blockedNote.hidden = false;
        blockedNote.textContent = 'blocked on ' + session.blockedOn +
          (session.pendingToolCallId ? ' · ' + session.pendingToolCallId.slice(0, 8) : '');
      }

      function renderCostPopover(session) {
        popoverTokensIn.textContent = typeof session.tokensIn === 'number' ? String(session.tokensIn) : '—';
        popoverTokensOut.textContent = typeof session.tokensOut === 'number' ? String(session.tokensOut) : '—';
        popoverModel.textContent = session.model || '—';
        popoverHarness.textContent = session.adapterSlug || '—';
        // The named wallet the session's access axis is bound to (profile
        // label/ref), falling back to the raw auth method — never a secret.
        popoverAuth.textContent = accessIdentity(session);
      }

      // Mirrors sessionDisplayName in client/sessionName.ts — this inline
      // script has no module system to import it from, so the precedence
      // (user-renamed-label, then the derived title, then a spawn label, then a
      // friendly adapter · short-id fallback) is duplicated here (FIX D) and
      // the two must stay in sync. Back-compat: an absent renamedByUser on a
      // labelled session is treated as a user rename (see sessionName.ts).
      function shortSessionId(id) {
        return id && id.length > 8 ? id.slice(-6) : (id || '');
      }
      function displayName(session) {
        const userRenamed = session.renamedByUser ?? session.label !== undefined;
        if (userRenamed && session.label !== undefined) return session.label;
        if (session.title !== undefined) return session.title;
        if (session.label !== undefined) return session.label;
        return (session.adapterSlug || session.kind) + ' · ' + shortSessionId(session.id);
      }

      function updateHeader(session) {
        // Don't stomp the inline rename box mid-edit — a sessionUpdate landing
        // while the user is typing must not wipe what they've entered.
        if (!isEditingTitle) headerTitle.textContent = displayName(session);
        // The harness mark, left of the name — which agent answers in this
        // tab, at a glance. Its title= names the harness so the glyph is never
        // a mystery. Empty (no adapter yet) collapses via CSS :empty.
        const mark = harnessGlyph(session.adapterSlug);
        headerIcon.textContent = session.adapterSlug ? mark.glyph : '';
        headerIcon.title = session.adapterSlug ? mark.label : '';
        // What will answer, shown where you type to it — the header no longer
        // repeats any of it. Each chip is omitted when the daemon doesn't
        // report the field (CSS :empty), rather than rendering "undefined". The
        // auth/access identity moved to the detail popover (FIX 3/4).
        composerHarness.textContent = session.adapterSlug || '';
        composerModel.textContent = session.model || '';

        // Cost only, on the button — the full in/out breakdown plus what
        // decides the rate (model/harness/auth) lives one click away, in the
        // popover, rather than crowding the header with numbers nobody acts
        // on at a glance.
        costBtn.textContent = typeof session.costUsd === 'number'
          ? '$' + session.costUsd.toFixed(4)
          : '—';
        renderCostPopover(session);
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
        // The blocked note's delay must elapse on a quiet poll too — nothing
        // else re-renders it while the session sits unchanged mid-block.
        refreshBlockedNote();
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

      // The stitched ancestor history (#resume-history, painted by
      // paintResumeChain below) counts as real content: a restarted session
      // with no live turns yet is NOT an empty conversation, it's one whose
      // newest turn happens to be an ancestor's — see the module's Problem-1
      // fix. Only when NEITHER live turns NOR ancestor history exist does
      // "no messages" actually hold.
      function hasResumeHistory() {
        const node = document.getElementById('resume-history');
        return node !== null && node.childNodes.length > 0;
      }

      function syncEmptyState() {
        const hasTurns = transcript.querySelector('.turn[data-turn-id]') !== null;
        const emptyNode = document.getElementById('empty');
        if (hasTurns || hasResumeHistory()) {
          if (emptyNode) emptyNode.remove();
        } else if (!emptyNode) {
          const e = el('div', undefined, 'No messages yet.');
          e.id = 'empty';
          transcript.appendChild(e);
        }
      }

      function renderUsage(usage) {
        // Context fill only — "ctx 206115/1000000" was two numbers the reader
        // had to divide, and the in/out totals that used to trail it merely
        // repeated what the cost button already shows. The raw counts move
        // to the popover — a title= tooltip is not a surface anyone finds.
        const used = usage && typeof usage.contextUsed === 'number' ? usage.contextUsed : usage && usage.used;
        const size = usage && typeof usage.contextSize === 'number' ? usage.contextSize : usage && usage.size;
        // Compact ring gauge (FIX 5) — the arc length is the fill fraction of
        // the ring's circumference, its colour the fill level.
        const gauge = contextGauge(used, size);
        contextBtn.hidden = !gauge;
        if (gauge) {
          const circumference = 2 * Math.PI * 6; // r=6 in the 16×16 viewBox
          ctxArc.setAttribute('stroke-dasharray', (gauge.ratio * circumference) + ' ' + circumference);
          ctxArc.classList.remove('mid', 'high');
          if (gauge.level !== 'low') ctxArc.classList.add(gauge.level);
          ctxPct.textContent = gauge.pct + '%';
        }
        popoverContextUsed.textContent = typeof used === 'number' ? String(used) : '—';
        popoverContextSize.textContent = typeof size === 'number' ? String(size) : '—';
        // A hidden button has nothing to open a popover onto either.
        if (!gauge) contextPopover.hidden = true;
      }

      // Wipes #transcript back to empty and immediately repaints the static
      // ancestor block (from lastResumeChain) as its first child. A blind
      // transcript.innerHTML reset would otherwise erase #resume-history
      // along with the live timeline, now that both share one scroll region
      // — this is the one place that reset happens, so every full-transcript
      // rebuild (renderFullConversation, and raw mode's init branch) routes
      // through it instead of touching transcript.innerHTML directly.
      function clearTranscript() {
        transcript.innerHTML = '';
        paintResumeChain();
      }

      // Full resync — used by 'init' (and a hypothetical future 'conversation'
      // full-resync message). Everything after this flows as 'patch'.
      function renderFullConversation(conv) {
        const atBottom = !isScrolledUp;
        clearTranscript();
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

      // A resume-chain ancestor's turns are rendered ONCE, statically — they
      // never patch again (the ancestor session is dead history), so this
      // deliberately does NOT go through upsertTurn/insertTurnInOrder (those
      // assume a live, ordered, re-patchable timeline keyed by a single
      // shared turn-id numbering — turn ids from a DIFFERENT session's own
      // reduceConversation aren't ordered against this session's at all).
      // buildSegmentShell/paintSegment are still reused as-is: they only
      // build/paint a segment from its own data, with no reference to the
      // live #transcript, so the same rendering fidelity (tool cards,
      // folded activity runs, plans, …) applies to frozen history for free.
      function renderStaticTurn(turn) {
        const node = el('div', 'turn turn-' + turn.role);
        if (turn.role === 'user') node.appendChild(el('div', 'role', 'You'));
        const bubble = el('div', 'bubble');
        node.appendChild(bubble);
        for (const seg of turn.segments || []) {
          const segNode = buildSegmentShell(seg);
          segNode.dataset.segId = seg.id;
          paintSegment(segNode, seg);
          bubble.appendChild(segNode);
        }
        markToolRuns(bubble);
        return node;
      }

      // #resume-history is built lazily (never part of the static HTML
      // skeleton) so it can be recreated as the first child of #transcript
      // after any full reset (clearTranscript) — always in front of the live
      // timeline, in the SAME scroll region, never a sibling pane of its own.
      function resumeHistoryContainer() {
        let node = document.getElementById('resume-history');
        if (!node) {
          node = el('div');
          node.id = 'resume-history';
          transcript.insertBefore(node, transcript.firstChild);
        }
        return node;
      }

      // Paints lastResumeChain into #resume-history. Split from
      // renderResumeChain (below) so clearTranscript can repaint the SAME
      // cached chain after a full reset without the caller re-sending it.
      // chain is already oldest-first (host-side reverse — see
      // transcriptPanelController.ts's buildResumeChain): each ancestor's
      // turns (or an "unavailable" note when its transcript couldn't load)
      // are followed by the divider describing HOW the next-more-recent
      // session resumed from it, so the sequence reads top-to-bottom as
      // "what happened, then it restarted, then what happened next" —
      // directly into the transcript's OWN scroll region, not a capped pane
      // above it.
      function paintResumeChain() {
        const container = resumeHistoryContainer();
        container.innerHTML = '';
        for (const entry of lastResumeChain || []) {
          if (entry.conversation && entry.conversation.turns) {
            for (const turn of entry.conversation.turns) {
              container.appendChild(renderStaticTurn(turn));
            }
          } else if (entry.unavailable) {
            container.appendChild(el('div', 'resume-unavailable',
              entry.unavailable === 'no-transcript'
                ? 'Earlier history not available (no structured transcript).'
                : 'Earlier history could not be loaded.'));
          }
          const via = entry.resumeVia ? ' (' + entry.resumeVia + ')' : ' (no continuity)';
          container.appendChild(el('div', 'resume-divider',
            '── restarted · resumed from ' + entry.sessionId + via + ' ──'));
        }
      }

      // Render the FULL resume chain, once, at init — see paintResumeChain
      // for the actual paint. Caching the chain in lastResumeChain is what
      // lets clearTranscript restore it after a later full reset.
      function renderResumeChain(chain) {
        lastResumeChain = chain || null;
        paintResumeChain();
      }

      // The wire prompt is text + every attachment path, space-joined: v1 hands
      // the agent readable PATHS (Decision A), so a chip collapses back into the
      // prompt string here. Keeping it a plain string is what lets the mid-turn
      // queue (which stores one string) carry attachments for free.
      function composePrompt() {
        const parts = [];
        const typed = input.value.trim();
        if (typed) parts.push(typed);
        for (let i = 0; i < attachments.length; i++) parts.push(attachments[i].path);
        return parts.join(' ');
      }

      function send(interrupt) {
        const composed = composePrompt();
        if (!composed) return;
        input.value = '';
        attachments = [];
        renderAttachments();
        closeMention();
        autoGrow();
        clearError();
        // Pushed here, not per-arm below: a queued message IS sent, just
        // later, so it belongs in history the moment the user commits to it.
        historyState = pushHistoryEntry(historyState, composed);
        // Mid-turn and not explicitly interrupting: hold it rather than POST a
        // prompt the daemon will refuse with a 409. It goes out on turn-end.
        if (busy && !interrupt) {
          queuedText = composed;
          refreshComposer();
          return;
        }
        vscode.postMessage({ type: interrupt ? 'interruptSend' : 'send', text: composed });
        refreshComposer();
      }

      // ── Attachment chips ──────────────────────────────────────────────
      function attachmentLabel(path) {
        const parts = path.split(/[\\/]/);
        return parts[parts.length - 1] || path;
      }

      function renderAttachments() {
        attachmentsRow.textContent = '';
        attachmentsRow.hidden = attachments.length === 0;
        for (let i = 0; i < attachments.length; i++) {
          const att = attachments[i];
          const chip = document.createElement('span');
          chip.className = 'attach-chip';
          chip.title = att.path;
          const label = document.createElement('span');
          label.className = 'attach-chip-label';
          label.textContent = att.label;
          chip.appendChild(label);
          const remove = document.createElement('span');
          remove.className = 'attach-chip-remove';
          remove.textContent = '✕';
          remove.title = 'Remove attachment';
          // Bind the path, not the index — the row is rebuilt on every change,
          // so an index would go stale the moment an earlier chip is removed.
          const path = att.path;
          remove.addEventListener('click', function() { removeAttachment(path); });
          chip.appendChild(remove);
          attachmentsRow.appendChild(chip);
        }
      }

      // Add a ready path (already on disk) as a chip. Enforces the count cap and
      // de-dupes, so mentioning or dropping the same file twice is a no-op.
      function addAttachment(path) {
        if (!path) return;
        for (let i = 0; i < attachments.length; i++) {
          if (attachments[i].path === path) { refreshComposer(); return; }
        }
        if (attachments.length >= ATTACHMENT_COUNT_CAP) {
          showError('Too many attachments',
            'Up to ' + ATTACHMENT_COUNT_CAP + ' attachments per message. Remove one to add another.');
          return;
        }
        attachments.push({ path: path, label: attachmentLabel(path) });
        renderAttachments();
        refreshComposer();
        input.focus();
      }

      function removeAttachment(path) {
        attachments = attachments.filter(function(a) { return a.path !== path; });
        renderAttachments();
        refreshComposer();
      }

      // Read a File to bytes and hand it to the host to store. Pre-checks the
      // size so an oversize file is refused HERE with a friendly message rather
      // than eating the route's 413 (Decision G). kind: 'image' (paste, no
      // name) or 'file' (drop, named).
      function uploadFile(file, kind) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          const mib = Math.round(file.size / (1024 * 1024));
          showError('File too large', 'That file is ' + mib + ' MiB — over the 32 MiB limit. It was not attached.');
          return;
        }
        if (file.size > WARN_ATTACHMENT_BYTES) {
          const mib = Math.round(file.size / (1024 * 1024));
          showError('Large attachment', 'That file is ' + mib + ' MiB — large for an attachment, but it was attached.');
        }
        file.arrayBuffer().then(function(buf) {
          if (kind === 'image') {
            vscode.postMessage({ type: 'attachImage', bytes: buf, mime: file.type });
          } else {
            vscode.postMessage({ type: 'attachFile', bytes: buf, mime: file.type, name: file.name || 'file' });
          }
        }).catch(function() {
          showError('Attachment failed', 'Could not read the file.');
        });
      }

      input.addEventListener('keydown', function(e) {
        // While the @mention popup is open it owns the arrow/enter/tab/escape
        // keys — otherwise Enter would send instead of picking a file.
        if (mention && handleMentionKey(e)) return;
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const noSelection = input.selectionStart === input.selectionEnd;
          // ↑ recalls once the caret is parked at the very start (index 0) —
          // in a multi-line draft it walks up the lines normally first, same
          // as VS Code's own chat — OR, once navigation is already underway,
          // unconditionally: shells and Claude Code both let ↑/↓ own the
          // keys for the rest of the walk, so a second ↑ steps to the NEXT
          // older entry instead of just re-parking the caret it already
          // placed at the end of the first recall. The accepted trade-off:
          // while navigating a recalled MULTI-LINE entry, ↑/↓ step through
          // history instead of moving between that entry's own lines.
          // Typing or clicking into the box is the escape hatch back to
          // normal caret movement (see the input/click listeners below).
          const eligible = e.key === 'ArrowUp'
            ? noSelection && (input.selectionStart === 0 || historyState.index !== null)
            : noSelection && historyState.index !== null;
          if (!eligible) return; // let the browser move the caret normally
          const recalled = recallHistory(historyState, e.key === 'ArrowUp' ? 'prev' : 'next', input.value);
          if (!recalled) return; // hit the end — don't consume the key
          e.preventDefault();
          historyState = recalled.state;
          input.value = recalled.value;
          const len = input.value.length;
          input.setSelectionRange(len, len);
          autoGrow();
          refreshComposer();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send(false);
        }
      });

      input.addEventListener('input', function() {
        // Setting .value programmatically (a recall) fires no input event, so
        // this only ever runs on REAL typing — the intended escape hatch out
        // of history navigation.
        historyState = { ...historyState, index: null };
        autoGrow();
        refreshComposer();
        updateMention();
      });

      // Clicking elsewhere in the textarea moves the caret out of an @token.
      input.addEventListener('click', function() {
        // A click means "I'm editing this now, not browsing" — exit history
        // navigation, same escape hatch as typing. Only the cursor resets;
        // entries/draft are untouched so history is still there next time.
        historyState = { ...historyState, index: null };
        updateMention();
      });

      // Paste an image → the agent reads it. The webview can't touch disk, so
      // it reads the pasted image to bytes and ships them to the host, which
      // stores the file and posts back a path (see 'attachmentUploaded').
      // preventDefault stops the same binary from ALSO landing as garbage text.
      input.addEventListener('paste', function(e) {
        const data = e.clipboardData;
        if (!data || !data.items) return;
        const images = [];
        for (let i = 0; i < data.items.length; i++) {
          const item = data.items[i];
          if (item.kind === 'file' && item.type && item.type.indexOf('image/') === 0) {
            const file = item.getAsFile();
            if (file) images.push(file);
          }
        }
        if (images.length === 0) return; // no image → let the normal text paste run
        e.preventDefault();
        for (let j = 0; j < images.length; j++) uploadFile(images[j], 'image');
      });

      // ── Drag and drop ─────────────────────────────────────────────────
      // A file dragged from the VS Code Explorer arrives as a uri-list with a
      // REAL on-disk path → attach it directly, no upload (Decision A1). A file
      // dragged from the OS arrives as raw bytes in dataTransfer.files → upload
      // it like a paste (A2).
      composer.addEventListener('dragover', function(e) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        composer.classList.add('drag-over');
      });
      composer.addEventListener('dragleave', function() { composer.classList.remove('drag-over'); });
      composer.addEventListener('drop', function(e) {
        e.preventDefault();
        composer.classList.remove('drag-over');
        const dt = e.dataTransfer;
        if (!dt) return;
        const uriList = (dt.getData && (dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list'))) || '';
        const paths = parseUriList(uriList);
        if (paths.length > 0) {
          for (let i = 0; i < paths.length; i++) addAttachment(paths[i]);
          return;
        }
        const files = dt.files;
        if (files && files.length > 0) {
          for (let j = 0; j < files.length; j++) uploadFile(files[j], 'file');
        }
      });

      // ── @mention popup ────────────────────────────────────────────────
      function closeMention() {
        mention = null;
        mentionPopup.hidden = true;
        mentionPopup.textContent = '';
      }

      // Recompute the active @token from the caret; ask the host for candidates.
      function updateMention() {
        const found = mentionQueryAt(input.value, input.selectionStart == null ? input.value.length : input.selectionStart);
        if (!found) { closeMention(); return; }
        // Keep any already-fetched items so the popup doesn't flicker empty
        // between the request and the response; correlate the response by query.
        mention = { start: found.start, end: found.end, query: found.query, items: mention ? mention.items : [], active: 0 };
        renderMention();
        vscode.postMessage({ type: 'requestMentions', query: found.query });
      }

      function renderMention() {
        if (!mention) return;
        mentionPopup.textContent = '';
        if (mention.items.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'mention-empty';
          empty.textContent = 'No matching files';
          mentionPopup.appendChild(empty);
          mentionPopup.hidden = false;
          return;
        }
        for (let i = 0; i < mention.items.length; i++) {
          const item = mention.items[i];
          const row = document.createElement('div');
          row.className = 'mention-item' + (i === mention.active ? ' active' : '');
          row.textContent = item.label;
          row.title = item.path;
          const idx = i;
          row.addEventListener('mousedown', function(ev) {
            // mousedown, not click: click fires after the textarea blurs, which
            // would tear the mention state down before the handler runs.
            ev.preventDefault();
            chooseMention(idx);
          });
          mentionPopup.appendChild(row);
        }
        mentionPopup.hidden = false;
      }

      // Returns true if it consumed the key (popup navigation), false otherwise.
      function handleMentionKey(e) {
        if (!mention) return false;
        if (e.key === 'Escape') { e.preventDefault(); closeMention(); return true; }
        if (mention.items.length === 0) return false;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          mention.active = (mention.active + 1) % mention.items.length;
          renderMention();
          return true;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          mention.active = (mention.active - 1 + mention.items.length) % mention.items.length;
          renderMention();
          return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          chooseMention(mention.active);
          return true;
        }
        return false;
      }

      // Replace the @token with the chosen file — as a chip, and the leftover
      // text keeps the caret. The path rides in composePrompt at send time.
      function chooseMention(index) {
        if (!mention || !mention.items[index]) return;
        const chosen = mention.items[index];
        const before = input.value.slice(0, mention.start);
        const after = input.value.slice(mention.end);
        const sep = after.length > 0 && after.charAt(0) !== ' ' ? ' ' : '';
        input.value = before + after.replace(/^\\s*/, sep ? '' : '');
        // Trim a leading space we might have left where the @token was.
        if (before.length === 0) input.value = input.value.replace(/^\\s+/, '');
        closeMention();
        addAttachment(chosen.path);
        autoGrow();
      }

      // Click the model chip → the host fetches this session's adapter
      // listing and shows a native quick-pick (no picker vocabulary lives in
      // the webview — see runChangeModelFlow / changeModel.logic.ts).
      composerModel.addEventListener('click', function() {
        vscode.postMessage({ type: 'changeModel' });
      });
      sendBtn.addEventListener('click', function() { send(false); });
      // Abandon the in-flight turn, send nothing — distinct from "Interrupt &
      // send" below, which takes the queued message NOW instead of waiting.
      stopBtn.addEventListener('click', function() {
        isStopping = true;
        refreshComposer();
        vscode.postMessage({ type: 'stop' });
      });
      // Interrupt only ever acts on the queued message — it's the only thing
      // waiting, and it's what the button offers to stop waiting for.
      interruptBtn.addEventListener('click', function() { flushQueued(true); });
      // The host resolves which session to restart from the CONTROLLER, not
      // from anything this message carries — see protocol.ts's restart doc.
      restartBtn.addEventListener('click', function() { vscode.postMessage({ type: 'restart' }); });
      queuedCancel.addEventListener('click', function() {
        queuedText = null;
        refreshComposer();
      });
      ebDismiss.addEventListener('click', clearError);

      // ── Header popovers ─────────────────────────────────────────────
      // A webview has no VS Code popover API, so this is plain DOM: toggle
      // on the button, dismiss on Escape or a click outside, and never more
      // than one open — opening either one closes the other first.
      const popovers = [costPopover, contextPopover];
      function closeAllPopovers() {
        for (const p of popovers) p.hidden = true;
      }
      function togglePopover(popover) {
        const wasOpen = !popover.hidden;
        closeAllPopovers();
        popover.hidden = wasOpen;
      }
      // Terminal button (FIX 2). A single lightweight jump to the raw terminal
      // view via the existing openTerminal command — no segmented control, no
      // restart. Shown only when the session HAS a terminal representation
      // (msg.canToggle), gated in the 'init' handler.
      openTerminalBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'openTerminal' });
      });
      // Click-to-edit rename (FIX B). Clicking the header title swaps its text
      // for an inline input prefilled with the CURRENT editable name (label,
      // else derived title — never the adapter·id fallback, which the user
      // shouldn't accidentally commit as a real name). Enter saves, Escape
      // cancels, blur saves. The host writes it as the label and the live
      // session-update repaints the header + tab + tree.
      function beginTitleEdit() {
        if (isEditingTitle || !lastSession) return;
        isEditingTitle = true;
        const input = document.createElement('input');
        input.type = 'text';
        input.setAttribute('aria-label', 'Rename session');
        input.value = lastSession.label ?? lastSession.title ?? '';
        headerTitle.textContent = '';
        headerTitle.appendChild(input);
        input.focus();
        input.select();
        let settled = false;
        const finish = function(save) {
          if (settled) return;
          settled = true;
          isEditingTitle = false;
          const next = input.value.trim();
          if (save) vscode.postMessage({ type: 'rename', name: next });
          // Restore text immediately — optimistic; the sessionUpdate confirms.
          headerTitle.textContent = save && next ? next : displayName(lastSession);
        };
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
          // Keep composer/global key handlers from reacting to typing in here.
          e.stopPropagation();
        });
        input.addEventListener('blur', function() { finish(true); });
      }
      headerTitle.addEventListener('click', beginTitleEdit);
      costBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        togglePopover(costPopover);
      });
      contextBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        togglePopover(contextPopover);
      });
      document.addEventListener('click', function(e) {
        if (!costPopover.contains(e.target) && e.target !== costBtn) costPopover.hidden = true;
        if (!contextPopover.contains(e.target) && e.target !== contextBtn) contextPopover.hidden = true;
      });
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeAllPopovers();
      });

      window.addEventListener('message', function(e) {
        const msg = e.data;
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'init':
            mode = msg.mode || 'raw';
            isScrolledUp = false;
            // Independent of mode — an ancestor's history renders as the
            // FIRST content in the SAME scroll region as the current
            // session's own content (structured OR raw), never a separate
            // capped pane. Cached/painted before the mode branch below so a
            // raw-mode reset (clearTranscript) already has it to repaint.
            // Only ever set here (init runs once per panel), never on
            // 'conversation'/'patch' — see protocol.ts's resumeChain doc.
            renderResumeChain(msg.resumeChain);
            if (mode === 'structured') {
              renderFullConversation(msg.conversation);
            } else {
              clearTranscript();
              // Suppress the dead "No transcript available" placeholder
              // when the stitched ancestor history above IS the transcript
              // — only show it when there's genuinely nothing at all (no
              // ancestor history AND no raw content either).
              const raw = msg.initialHtml || (hasResumeHistory() ? '' : '<div id="empty">No transcript available.</div>');
              if (raw) {
                const rawWrap = el('div');
                rawWrap.innerHTML = raw;
                while (rawWrap.firstChild) transcript.appendChild(rawWrap.firstChild);
              }
              transcript.scrollTop = transcript.scrollHeight;
            }
            // A view flip (FIX 2) re-posts 'init' WITHOUT a history field so
            // the accumulated ↑/↓ history survives the switch; the first init
            // always carries one (possibly []), which seeds it.
            historyState = { entries: msg.history || historyState.entries, index: null, draft: '' };
            openTerminalBtn.hidden = !msg.canToggle;
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
          case 'attachmentUploaded':
            addAttachment(msg.path);
            break;
          case 'attachError':
            showError(msg.title || 'Attachment failed', msg.message || '');
            break;
          case 'mentionCandidates':
            // Ignore a response that arrived after the user typed on — only the
            // query currently in the box should paint (see updateMention).
            if (mention && msg.query === mention.query) {
              mention.items = msg.items || [];
              if (mention.active >= mention.items.length) mention.active = 0;
              renderMention();
            }
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
          case 'stopError':
            isStopping = false;
            refreshComposer();
            showError(msg.title || 'Stop failed', msg.message || '');
            break;
        }
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`
}
