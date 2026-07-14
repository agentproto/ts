/**
 * Transcript webview panel — a live chat/output view for a single session.
 *
 * Implements the WP4 contract:
 *   - One WebviewPanel per session id (viewType `agentproto.transcript`).
 *   - Theme-aware HTML using VS Code CSS variables.
 *   - Initial transcript rendered from `exportSession("markdown")` with a
 *     `preview(200)` fallback.
 *   - Live output streamed via `SessionStore.focusOutput()`.
 *   - Send / interrupt-send / kill actions wired to the daemon client.
 *   - Clean disposal of subscriptions when the panel closes.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor, SessionStreamLine } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"

import { renderMarkdown } from "./markdown.js"
import { formatTitle } from "./transcript.logic.js"
import { isWebviewMessage, type ExtMessage, type WebviewMessage } from "./protocol.js"

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
      panel.webview.html = buildHtml(panel.webview, nonce)

      const disposables: vscode.Disposable[] = []

      // Live session updates (cost, status, tokens).
      disposables.push(
        store.onDidChange(() => {
          const updated = store.sessions.find(s => s.id === session.id)
          if (updated) {
            postMessage(panel, { type: "sessionUpdate", session: updated })
          }
        }),
      )

      // Live output stream.
      const focusSub = store.focusOutput(session.id, {
        onLine: (line: SessionStreamLine) => {
          postMessage(panel, { type: "lines", lines: [line] })
        },
      })
      disposables.push(focusSub)

      // Message handling from the webview.
      disposables.push(
        panel.webview.onDidReceiveMessage(async (raw: unknown) => {
          if (!isWebviewMessage(raw)) return
          try {
            await handleWebviewMessage(raw, session.id, client, panel)
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
    },
  }
}

async function handleWebviewMessage(
  msg: WebviewMessage,
  sessionId: string,
  client: DaemonClient,
  panel: vscode.WebviewPanel,
): Promise<void> {
  switch (msg.type) {
    case "ready": {
      const initialContent = await fetchInitialContent(client, sessionId)
      // Re-fetch the freshest session descriptor from the store is not
      // possible here without a back-reference, so we ask the daemon once.
      const current = await client.getSession(sessionId)
      postMessage(panel, {
        type: "init",
        session: current,
        nonce: "",
        // innerHTML sink in the webview — must go through renderMarkdown,
        // which escapes the raw daemon text before adding markup.
        initialHtml: renderMarkdown(initialContent),
      })
      return
    }
    case "send":
      await client.prompt(sessionId, msg.text)
      return
    case "interruptSend":
      await client.prompt(sessionId, msg.text, { interrupt: true })
      return
    case "kill":
      await client.kill(sessionId)
      return
  }
}

async function fetchInitialContent(client: DaemonClient, id: string): Promise<string> {
  try {
    const exported = await client.exportSession(id, "markdown")
    return exported.content ?? ""
  } catch {
    try {
      const preview = await client.preview(id, 200)
      return preview.lines.join("\n")
    } catch {
      return ""
    }
  }
}

function postMessage(panel: vscode.WebviewPanel, msg: ExtMessage): void {
  void panel.webview.postMessage(msg)
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
    </div>
  </div>
  <div id="transcript"><div id="empty">Loading transcript…</div></div>
  <div id="input-area">
    <textarea id="input" placeholder="Type a message… (Enter to send, Shift+Enter for newline)"></textarea>
    <div class="button-stack">
      <button id="send">Send</button>
      <button id="interrupt-send" class="secondary">Interrupt & send</button>
      <button id="kill" class="danger">Kill</button>
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
      const input = document.getElementById('input');
      const sendBtn = document.getElementById('send');
      const interruptBtn = document.getElementById('interrupt-send');
      const killBtn = document.getElementById('kill');

      let exited = false;
      let isScrolledUp = false;

      function setInputEnabled(enabled) {
        input.disabled = !enabled;
        sendBtn.disabled = !enabled;
        interruptBtn.disabled = !enabled;
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
            updateHeader(msg.session);
            transcript.innerHTML = msg.initialHtml || '<div id="empty">No transcript available.</div>';
            exited = ['exited', 'killed', 'error'].indexOf(msg.session.status) !== -1;
            setInputEnabled(!exited);
            transcript.scrollTop = transcript.scrollHeight;
            isScrolledUp = false;
            break;
          case 'sessionUpdate':
            updateHeader(msg.session);
            exited = ['exited', 'killed', 'error'].indexOf(msg.session.status) !== -1;
            setInputEnabled(!exited);
            break;
          case 'lines':
            appendLines(msg.lines);
            break;
        }
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`
}
