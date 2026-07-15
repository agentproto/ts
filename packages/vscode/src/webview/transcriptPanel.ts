/**
 * Transcript webview panel — a live chat/output view for a single session.
 *
 * Implements the WP4 contract:
 *   - One WebviewPanel per session id (viewType `agentproto.transcript`).
 *   - Theme-aware HTML using VS Code's CSS variables.
 *   - Initial transcript rendered from `exportSession("markdown")` with a
 *     `preview(200)` fallback.
 *   - Live output streamed via `SessionStore.focusOutput()`.
 *   - Send / interrupt-send / kill actions wired to the daemon client.
 *   - Clean disposal of subscriptions when the panel closes.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"

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
): TranscriptPanels {
  const panels = new Map<string, vscode.WebviewPanel>()
  let activeId: string | undefined

  return {
    open(session: SessionDescriptor): void {
      const existing = panels.get(session.id)
      if (existing) {
        existing.reveal(vscode.ViewColumn.One, false)
        activeId = session.id
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
          if (updated) controller.onSessionUpdate(updated)
        }),
      )

      // Message handling from the webview. Register before setting HTML so the
      // handler is in place if the webview posts `ready` synchronously.
      disposables.push(
        panel.webview.onDidReceiveMessage(async (raw: unknown) => {
          if (!isWebviewMessage(raw)) return
          try {
            await handleWebviewMessage(raw, controller)
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
          if (e.webviewPanel.active) activeId = session.id
          else if (activeId === session.id) activeId = undefined
        }),
      )

      // Cleanup on close.
      panel.onDidDispose(() => {
        for (const d of disposables) d.dispose()
        panels.delete(session.id)
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
    case "kill":
      await controller.onKill()
      return
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
    .chip-busy { background: var(--vscode-progressBar-background); color: var(--vscode-editor-background); }
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
    details.reasoning, details.tool {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 5px;
      padding: 3px 8px;
      background: var(--vscode-textCodeBlock-background);
    }
    details.reasoning > summary, details.tool > summary {
      cursor: pointer;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      user-select: none;
      list-style: revert;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    details.reasoning[open] > summary, details.tool[open] > summary { margin-bottom: 6px; white-space: normal; }
    .reasoning-body {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    details.tool > summary { font-family: var(--vscode-editor-font-family); }
    details.tool-error { border-color: var(--vscode-errorForeground); }
    /* ── Activity group (folded reasoning/tool run) ────────────────── */
    details.activity {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 5px;
      background: var(--vscode-textCodeBlock-background);
      padding: 3px 8px;
    }
    details.activity > summary {
      cursor: pointer;
      user-select: none;
      list-style: revert;
      display: flex;
      align-items: baseline;
      gap: 6px;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    details.activity[open] > summary { margin-bottom: 6px; }
    .act-badge { flex: 0 0 auto; }
    .act-label {
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-editor-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .act-elapsed:empty { display: none; }
    /* The fold's children indent under the summary so the run reads as a tree. */
    .act-children {
      border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      margin-left: 4px;
      padding-left: 8px;
    }
    details.activity-error { border-color: var(--vscode-errorForeground); }
    details.activity.tool-still-running { border-color: var(--vscode-editorWarning-foreground); }
    .tool-still-running > summary > .act-elapsed {
      color: var(--vscode-editorWarning-foreground);
      font-weight: 600;
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
    .tool-args, .tool-result {
      margin: 0;
      background: var(--vscode-editor-background);
      padding: 6px 8px;
      border-radius: 4px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
    }
    .tool-pending-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    .tool-spinner {
      flex: 0 0 auto;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--vscode-progressBar-background);
      animation: agentproto-pulse 1.1s ease-in-out infinite;
    }
    @keyframes agentproto-pulse {
      0%, 100% { opacity: 0.35; transform: scale(0.85); }
      50% { opacity: 1; transform: scale(1); }
    }
    details.tool.tool-still-running {
      border-color: var(--vscode-editorWarning-foreground);
    }
    .tool-still-running .tool-elapsed {
      color: var(--vscode-editorWarning-foreground);
      font-weight: 600;
    }
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
    @keyframes agentproto-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    /* Honour the OS "reduce motion" setting — this thing spins for minutes. */
    @media (prefers-reduced-motion: reduce) {
      #working-glyph { animation: none; }
      .tool-spinner { animation: none; }
    }
    /* ── Composer ─────────────────────────────────────────────────────
       One bordered box that OWNS the textarea and its action row, rather
       than a textarea sitting next to a stack of coloured buttons. Actions
       are ghost-styled and live inside the box on one line: the destructive
       one earns colour on hover only, so a red slab never sits permanently
       under the user's eyes. */
    #input-area {
      flex: 0 0 auto;
      padding: 10px 14px 12px;
      background-color: var(--vscode-editor-background);
    }
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
    <div id="composer">
      <textarea id="input" rows="1" placeholder="Reply to the agent…"></textarea>
      <div id="composer-bar">
        <span id="composer-meta">
          <span id="composer-adapter" class="composer-chip"></span>
          <span id="composer-model" class="composer-chip"></span>
        </span>
        <span id="send-status"></span>
        <button id="interrupt-send" hidden title="Interrupt the current turn and send this instead">Interrupt &amp; send</button>
        <button id="kill" title="Kill this session">Kill</button>
        <button id="send" title="Send (Enter)">↵</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      const headerTitle = document.getElementById('header-title');
      const statusChip = document.getElementById('status-chip');
      const headerBlocked = document.getElementById('header-blocked');
      const costEl = document.getElementById('cost');
      const transcript = document.getElementById('transcript');
      const convUsage = document.getElementById('conv-usage');
      const working = document.getElementById('working');
      const workingText = document.getElementById('working-text');
      const composer = document.getElementById('composer');
      const composerAdapter = document.getElementById('composer-adapter');
      const composerModel = document.getElementById('composer-model');
      const input = document.getElementById('input');
      const sendBtn = document.getElementById('send');
      const interruptBtn = document.getElementById('interrupt-send');
      const killBtn = document.getElementById('kill');
      const sendStatus = document.getElementById('send-status');

      let exited = false;
      let busy = false;
      /** Wall-clock ms when the current turn started (0 when idle). */
      let busySince = 0;
      let lastTokensOut;
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
        interruptBtn.disabled = !live || !hasText;
        interruptBtn.hidden = !busy || exited;
        killBtn.disabled = exited;
        composer.classList.toggle('disabled', exited);
      }

      // "Working…" plus how long and how much — the three things a user
      // waiting on a reply actually wants, without expanding anything.
      function refreshWorking() {
        working.hidden = !busy;
        if (!busy) return;
        const parts = ['Working…'];
        if (busySince) parts.push(Math.max(0, Math.round((Date.now() - busySince) / 1000)) + 's');
        if (typeof lastTokensOut === 'number') parts.push(lastTokensOut + ' tokens');
        workingText.textContent = parts.join(' · ');
      }

      function applySession(session) {
        updateHeader(session);
        exited = isTerminal(session);
        // A terminal session is never busy, whatever the descriptor says — see
        // isTerminal. Without this a killed session span the working row forever.
        const nowBusy = !exited && Boolean(session.busy);
        if (nowBusy && !busy) busySince = Date.now();
        if (!nowBusy) busySince = 0;
        busy = nowBusy;
        if (typeof session.tokensOut === 'number') lastTokensOut = session.tokensOut;
        refreshComposer();
        refreshWorking();
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

      function computeStatusChip(session) {
        const s = session.status;
        if (s === 'exited' || s === 'killed' || s === 'error') return 'exited';
        if (session.busy) return 'busy';
        if (session.awaitingInput) return 'awaiting-input';
        if (s === 'running') return 'running';
        return s || 'starting';
      }

      function updateHeader(session) {
        headerTitle.textContent = session.label || session.id || '';
        // adapter/model deliberately NOT repeated here — they live in the
        // composer bar, next to where the user types to them.
        composerAdapter.textContent = session.adapterSlug || '';
        composerModel.textContent = session.model || '';

        const chip = computeStatusChip(session);
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

        const costParts = [];
        if (typeof session.costUsd === 'number') {
          costParts.push('$' + session.costUsd.toFixed(4));
        }
        const tokParts = [];
        if (typeof session.tokensIn === 'number') tokParts.push('in ' + session.tokensIn);
        if (typeof session.tokensOut === 'number') tokParts.push('out ' + session.tokensOut);
        if (tokParts.length) costParts.push(tokParts.join(' · '));
        costEl.textContent = costParts.join(' · ') || '—';
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
            const badge = seg.status === 'error' ? '✗' : seg.status === 'ok' ? '✓' : '…';
            node.className = 'seg tool tool-' + seg.status;
            const summary = node.querySelector(':scope > summary');
            summary.textContent = badge + ' ' + (seg.toolName || 'tool');
            // Rebuild everything after <summary> — cheap (a handful of
            // nodes) and simpler than diffing input/pending/output fields
            // individually; the shell (and its open state) is untouched.
            while (summary.nextSibling) node.removeChild(summary.nextSibling);
            if (seg.argsText !== undefined) {
              node.appendChild(el('div', 'tool-field-label', 'input'));
              const p = el('pre', 'tool-args');
              p.innerHTML = seg.argsText;
              node.appendChild(p);
            }
            if (seg.status === 'pending') {
              const row = el('div', 'tool-pending-row');
              row.appendChild(el('span', 'tool-spinner'));
              const label = el('span', 'tool-elapsed');
              row.appendChild(label);
              node.appendChild(row);
              const startedMs = seg.ts ? Date.parse(seg.ts) : NaN;
              const entry = { startedMs: isNaN(startedMs) ? Date.now() : startedMs, label, node };
              pendingTools.set(seg.id, entry);
              paintElapsed(entry);
            } else {
              pendingTools.delete(seg.id);
              node.classList.remove('tool-still-running');
            }
            if (seg.resultText !== undefined) {
              node.appendChild(el('div', 'tool-field-label', 'output'));
              const p = el('pre', 'tool-result');
              p.innerHTML = seg.resultText;
              node.appendChild(p);
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
            summary.textContent = '';
            const badge = seg.status === 'error' ? '✗' : seg.status === 'ok' ? '✓' : '…';
            summary.appendChild(el('span', 'act-badge', badge));
            summary.appendChild(el('span', 'act-label', seg.summary || ''));
            const elapsed = el('span', 'act-elapsed');
            summary.appendChild(elapsed);
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
        // "ctx 206115/1000000" is two numbers the reader has to divide. What
        // they actually want to know is how full the window is, so show the
        // percent and keep the raw counts in the tooltip.
        const used = typeof usage.contextUsed === 'number' ? usage.contextUsed : usage.used;
        const size = typeof usage.contextSize === 'number' ? usage.contextSize : usage.size;
        if (typeof used === 'number' && typeof size === 'number' && size > 0) {
          parts.push('ctx ' + Math.round((used / size) * 100) + '%');
          convUsage.title = 'context ' + used + ' / ' + size;
        } else {
          convUsage.title = '';
        }
        if (typeof usage.tokensIn === 'number') parts.push('in ' + usage.tokensIn);
        if (typeof usage.tokensOut === 'number') parts.push('out ' + usage.tokensOut);
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
        vscode.postMessage({ type: interrupt ? 'interruptSend' : 'send', text: text.trim() });
        input.value = '';
        autoGrow();
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
      interruptBtn.addEventListener('click', function() { send(true); });
      killBtn.addEventListener('click', function() {
        if (confirm('Kill this session?')) {
          vscode.postMessage({ type: 'kill' });
        }
      });

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
            sendStatus.textContent = msg.message || 'Send failed';
            break;
        }
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`
}
