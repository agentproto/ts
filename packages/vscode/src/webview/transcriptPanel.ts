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
}

export function registerTranscriptPanels(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): TranscriptPanels {
  const panels = new Map<string, vscode.WebviewPanel>()

  return {
    open(session: SessionDescriptor): void {
      const existing = panels.get(session.id)
      if (existing) {
        existing.reveal(vscode.ViewColumn.One, false)
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

      // Cleanup on close.
      panel.onDidDispose(() => {
        for (const d of disposables) d.dispose()
        panels.delete(session.id)
      })

      // Set HTML only after the controller and message listener are wired up.
      panel.webview.html = buildHtml(panel.webview, nonce)
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

function buildHtml(webview: vscode.Webview, nonce: string): string {
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
    #header-subtitle { }
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
      padding: 4px 8px;
      background: var(--vscode-textCodeBlock-background);
    }
    details.reasoning > summary, details.tool > summary {
      cursor: pointer;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      user-select: none;
      list-style: revert;
    }
    details.reasoning[open] > summary, details.tool[open] > summary { margin-bottom: 6px; }
    .reasoning-body {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    details.tool > summary { font-family: var(--vscode-editor-font-family); }
    details.tool-error { border-color: var(--vscode-errorForeground); }
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
    #input-area {
      flex: 0 0 auto;
      padding: 10px 14px;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, rgba(128,128,128,0.3)));
      background-color: var(--vscode-sideBar-background);
      display: flex;
      gap: 8px;
      align-items: flex-start;
    }
    #input {
      flex: 1 1 auto;
      resize: vertical;
      min-height: 60px;
      max-height: 200px;
      padding: 8px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    #input:disabled { opacity: 0.6; cursor: not-allowed; }
    .button-stack {
      flex: 0 0 auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    button {
      padding: 6px 12px;
      border: none;
      border-radius: 4px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-size: 0.95em;
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.danger {
      background: var(--vscode-errorForeground);
      color: var(--vscode-editor-background);
    }
    #send-status {
      font-size: 0.85em;
      color: var(--vscode-errorForeground);
      min-height: 1.2em;
    }
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
      <span id="header-subtitle"></span>
      <span id="status-chip" class="chip chip-starting"></span>
      <span id="cost"></span>
      <span id="conv-usage"></span>
    </div>
  </div>
  <div id="transcript"><div id="empty">Loading transcript…</div></div>
  <div id="input-area">
    <textarea id="input" placeholder="Type a message… (Enter to send, Shift+Enter for newline)"></textarea>
    <div class="button-stack">
      <button id="send">Send</button>
      <button id="interrupt-send" class="secondary">Interrupt & send</button>
      <button id="kill" class="danger">Kill</button>
      <span id="send-status"></span>
    </div>
  </div>
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      const headerTitle = document.getElementById('header-title');
      const headerSubtitle = document.getElementById('header-subtitle');
      const statusChip = document.getElementById('status-chip');
      const costEl = document.getElementById('cost');
      const transcript = document.getElementById('transcript');
      const convUsage = document.getElementById('conv-usage');
      const input = document.getElementById('input');
      const sendBtn = document.getElementById('send');
      const interruptBtn = document.getElementById('interrupt-send');
      const killBtn = document.getElementById('kill');
      const sendStatus = document.getElementById('send-status');

      let exited = false;
      let isScrolledUp = false;
      let isSending = false;
      let mode = 'raw';
      // Segment ids the user has expanded — preserved across re-renders so a
      // live update never collapses an open reasoning/tool card.
      const openSegments = new Set();

      function setInputEnabled(enabled) {
        input.disabled = !enabled || isSending;
        sendBtn.disabled = !enabled || isSending;
        interruptBtn.disabled = !enabled || isSending;
      }

      function setSending(sending) {
        isSending = sending;
        setInputEnabled(!exited);
        sendStatus.textContent = sending ? 'Sending…' : '';
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
        const parts = [];
        if (session.adapterSlug) parts.push(session.adapterSlug);
        if (session.model) parts.push(session.model);
        headerSubtitle.textContent = parts.join(' · ');

        const chip = computeStatusChip(session);
        statusChip.textContent = chip;
        statusChip.className = 'chip chip-' + chip;

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
          div.textContent = typeof line.line === 'string' ? line.line : String(line.line);
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

      function captureOpenState() {
        const details = transcript.querySelectorAll('details[data-seg]');
        for (const d of details) {
          if (d.open) openSegments.add(d.dataset.seg);
          else openSegments.delete(d.dataset.seg);
        }
      }

      function makeDetails(seg, className, summaryText) {
        const det = document.createElement('details');
        det.className = className;
        det.dataset.seg = seg.id;
        if (openSegments.has(seg.id)) det.open = true;
        const summary = document.createElement('summary');
        summary.textContent = summaryText;
        det.appendChild(summary);
        return det;
      }

      function renderSegment(seg) {
        switch (seg.kind) {
          case 'user':
          case 'assistant-text': {
            const d = el('div', 'seg text');
            d.innerHTML = seg.html || '';
            return d;
          }
          case 'reasoning': {
            const det = makeDetails(seg, 'seg reasoning', 'Reasoning');
            const body = el('div', 'reasoning-body');
            body.innerHTML = seg.html || '';
            det.appendChild(body);
            return det;
          }
          case 'tool': {
            const badge = seg.status === 'error' ? '✗' : seg.status === 'ok' ? '✓' : '…';
            const det = makeDetails(seg, 'seg tool tool-' + seg.status, badge + ' ' + (seg.toolName || 'tool'));
            if (seg.argsText !== undefined) {
              det.appendChild(el('div', 'tool-field-label', 'input'));
              const p = el('pre', 'tool-args');
              p.innerHTML = seg.argsText;
              det.appendChild(p);
            }
            if (seg.resultText !== undefined) {
              det.appendChild(el('div', 'tool-field-label', 'output'));
              const p = el('pre', 'tool-result');
              p.innerHTML = seg.resultText;
              det.appendChild(p);
            }
            return det;
          }
          case 'plan': {
            const d = el('div', 'seg plan');
            d.appendChild(el('div', 'plan-head', 'Plan ' + seg.done + '/' + seg.total));
            const ul = el('ul', 'plan-list');
            for (const entry of seg.entries || []) {
              const mark = entry.status === 'completed' ? '☑ '
                : entry.status === 'in_progress' ? '▸ ' : '☐ ';
              ul.appendChild(el('li', 'plan-' + entry.status, mark + entry.content));
            }
            d.appendChild(ul);
            return d;
          }
          case 'agent-question': {
            const d = el('div', 'seg question');
            d.appendChild(el('div', undefined, 'Awaiting your decision'));
            if (seg.options && seg.options.length) {
              const ul = el('ul');
              for (const opt of seg.options) ul.appendChild(el('li', undefined, opt));
              d.appendChild(ul);
            }
            return d;
          }
          case 'error': {
            const d = el('div', 'seg error');
            d.innerHTML = seg.text || '';
            return d;
          }
          default:
            return el('div');
        }
      }

      function renderTurn(turn) {
        const wrap = el('div', 'turn turn-' + turn.role);
        wrap.appendChild(el('div', 'role', turn.role === 'user' ? 'You' : 'Assistant'));
        const bubble = el('div', 'bubble');
        for (const seg of turn.segments) bubble.appendChild(renderSegment(seg));
        wrap.appendChild(bubble);
        return wrap;
      }

      function renderUsage(usage) {
        if (!usage) { convUsage.textContent = ''; return; }
        const parts = [];
        if (typeof usage.contextUsed === 'number' && typeof usage.contextSize === 'number') {
          parts.push('ctx ' + usage.contextUsed + '/' + usage.contextSize);
        } else if (typeof usage.used === 'number' && typeof usage.size === 'number') {
          parts.push('ctx ' + usage.used + '/' + usage.size);
        }
        if (typeof usage.tokensIn === 'number') parts.push('in ' + usage.tokensIn);
        if (typeof usage.tokensOut === 'number') parts.push('out ' + usage.tokensOut);
        convUsage.textContent = parts.join(' · ');
      }

      function renderConversation(conv) {
        captureOpenState();
        const atBottom = !isScrolledUp;
        transcript.innerHTML = '';
        if (!conv || !conv.turns || conv.turns.length === 0) {
          const empty = el('div', undefined, 'No messages yet.');
          empty.id = 'empty';
          transcript.appendChild(empty);
        } else {
          for (const turn of conv.turns) transcript.appendChild(renderTurn(turn));
        }
        renderUsage(conv && conv.usage);
        if (atBottom) transcript.scrollTop = transcript.scrollHeight;
      }

      function send(interrupt) {
        const text = input.value;
        if (!text || !text.trim()) return;
        vscode.postMessage({ type: interrupt ? 'interruptSend' : 'send', text: text.trim() });
        input.value = '';
      }

      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send(false);
        }
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
            updateHeader(msg.session);
            isScrolledUp = false;
            if (mode === 'structured') {
              renderConversation(msg.conversation);
            } else {
              transcript.innerHTML = msg.initialHtml || '<div id="empty">No transcript available.</div>';
              transcript.scrollTop = transcript.scrollHeight;
            }
            exited = ['exited', 'killed', 'error'].indexOf(msg.session.status) !== -1;
            setInputEnabled(!exited);
            break;
          case 'conversation':
            renderConversation(msg.conversation);
            break;
          case 'sessionUpdate':
            updateHeader(msg.session);
            exited = ['exited', 'killed', 'error'].indexOf(msg.session.status) !== -1;
            setInputEnabled(!exited);
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
