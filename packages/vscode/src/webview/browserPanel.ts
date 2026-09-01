/**
 * Browser live-view panel — a per-session VS Code editor tab (viewType
 * `agentproto.browser`) that polls `browser_screenshot` and renders the
 * latest frame, so a `kind: "browser"` session has somewhere to open at all
 * (previously it fell through to an empty/raw transcript).
 *
 * The extension side owns the poll loop (2s while visible, backing off to 5s
 * after 3 consecutive failures — see `nextPollDelayMs` in
 * browserPanel.logic.ts) and pushes frames to the webview; the webview is a
 * thin renderer plus a Pause/Resume/Refresh control surface that posts back
 * `{type:"pause"|"resume"|"refresh"}`.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import { formatTitle } from "./transcript.logic.js"
import { frameMessage, nextPollDelayMs, type BrowserScreenshotResult } from "./browserPanel.logic.js"

export interface BrowserPanels {
  open(session: SessionDescriptor): void
}

interface PanelState {
  paused: boolean
  disposed: boolean
  running: boolean
  consecutiveFailures: number
  timer?: ReturnType<typeof setTimeout>
}

function isActive(state: PanelState, panel: vscode.WebviewPanel): boolean {
  return !state.disposed && !state.paused && panel.visible
}

function stopLoop(state: PanelState): void {
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = undefined
  }
}

function startLoop(state: PanelState, panel: vscode.WebviewPanel, fetchFrame: () => Promise<void>): void {
  if (state.running || !isActive(state, panel)) return
  state.running = true
  const tick = (): void => {
    if (!isActive(state, panel)) {
      state.running = false
      return
    }
    void fetchFrame().finally(() => {
      if (!isActive(state, panel)) {
        state.running = false
        return
      }
      state.timer = setTimeout(tick, nextPollDelayMs(state.consecutiveFailures))
    })
  }
  tick()
}

export function registerBrowserPanels(ctx: vscode.ExtensionContext, client: DaemonClient): BrowserPanels {
  const panels = new Map<string, vscode.WebviewPanel>()

  return {
    open(session: SessionDescriptor): void {
      const existing = panels.get(session.id)
      if (existing) {
        existing.reveal(vscode.ViewColumn.One, false)
        return
      }

      const panel = vscode.window.createWebviewPanel(
        "agentproto.browser",
        `${formatTitle(session)} — browser`,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      )
      panels.set(session.id, panel)

      const state: PanelState = { paused: false, disposed: false, running: false, consecutiveFailures: 0 }
      const post = (msg: unknown): void => void panel.webview.postMessage(msg)

      const fetchFrame = async (): Promise<void> => {
        try {
          const result = await client.mcpCall<BrowserScreenshotResult>("browser_screenshot", {
            sessionId: session.id,
          })
          state.consecutiveFailures = 0
          post(frameMessage(result, Date.now()))
        } catch (err) {
          state.consecutiveFailures += 1
          post({ type: "error", message: err instanceof Error ? err.message : String(err) })
        }
      }

      panel.webview.onDidReceiveMessage(
        (raw: unknown) => {
          if (typeof raw !== "object" || raw === null || !("type" in raw)) return
          const type = (raw as { type: unknown }).type
          if (type === "ready") {
            // The webview only attaches its `message` listener once this fires —
            // posting the session (or a frame) any earlier is lost. Kick the poll
            // loop off from here too, so the very first fetch isn't wasted on a
            // frame nobody was listening for yet.
            post({ type: "session", session })
            startLoop(state, panel, fetchFrame)
          } else if (type === "pause") {
            state.paused = true
            stopLoop(state)
          } else if (type === "resume") {
            state.paused = false
            startLoop(state, panel, fetchFrame)
          } else if (type === "refresh") {
            void fetchFrame()
          }
        },
        undefined,
        ctx.subscriptions,
      )

      panel.onDidChangeViewState(() => {
        if (panel.visible) startLoop(state, panel, fetchFrame)
        else stopLoop(state)
      })

      panel.onDidDispose(() => {
        state.disposed = true
        stopLoop(state)
        panels.delete(session.id)
      })

      panel.webview.html = buildBrowserHostHtml(randomNonce())
    },
  }
}

function randomNonce(): string {
  return randomBytes(16).toString("hex")
}

export function buildBrowserHostHtml(nonce: string): string {
  const csp = [
    "default-src 'none'",
    "img-src data:",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ")

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>agentproto browser</title>
  <style>
    :root {
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
    body { display: flex; flex-direction: column; }
    header {
      display: flex; align-items: center; gap: 10px; padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      font-size: 12px; color: var(--vscode-descriptionForeground); flex: 0 0 auto;
    }
    header .title { color: var(--vscode-foreground); font-weight: 600; }
    header .spacer { flex: 1 1 auto; }
    button {
      height: 24px; padding: 0 10px; font-size: 11px; cursor: pointer;
      background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
      border: none; outline: none;
    }
    button:focus { outline: 1px solid var(--vscode-focusBorder); }
    .error {
      display: none; padding: 6px 10px; font-size: 12px;
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
      border-bottom: 1px solid var(--vscode-inputValidation-errorBorder, transparent);
      flex: 0 0 auto;
    }
    .error.visible { display: block; }
    .frame {
      flex: 1 1 auto; display: flex; align-items: center; justify-content: center;
      background: #000; overflow: hidden;
    }
    .frame img { max-width: 100%; max-height: 100%; object-fit: contain; display: none; }
    .frame img.visible { display: block; }
    .empty { color: var(--vscode-descriptionForeground); font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <span class="title" id="title">Browser</span>
    <span id="meta"></span>
    <span class="spacer"></span>
    <span id="updated"></span>
    <button id="btn-pause">Pause</button>
    <button id="btn-refresh">Refresh</button>
  </header>
  <div class="error" id="error"></div>
  <div class="frame" id="frame">
    <span class="empty" id="empty">Waiting for the first frame…</span>
    <img id="img" alt="browser session frame">
  </div>

  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const titleEl = document.getElementById('title');
      const metaEl = document.getElementById('meta');
      const updatedEl = document.getElementById('updated');
      const errorEl = document.getElementById('error');
      const imgEl = document.getElementById('img');
      const emptyEl = document.getElementById('empty');
      const btnPause = document.getElementById('btn-pause');
      const btnRefresh = document.getElementById('btn-refresh');

      let paused = false;
      let lastAt = null;

      function renderSession(session) {
        titleEl.textContent = session.label || session.title || session.id;
        const parts = [];
        if (session.browserAdapterId) parts.push(session.browserAdapterId);
        if (session.browserBaseUrl) parts.push(session.browserBaseUrl);
        if (session.browserLocation) parts.push(session.browserLocation);
        if (session.status) parts.push(session.status);
        metaEl.textContent = parts.join(' · ');
      }

      function renderUpdated() {
        if (lastAt === null) {
          updatedEl.textContent = '';
          return;
        }
        const secs = Math.max(0, Math.round((Date.now() - lastAt) / 1000));
        updatedEl.textContent = 'updated ' + secs + 's ago';
      }

      setInterval(renderUpdated, 1000);

      window.addEventListener('message', function (event) {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === 'session') {
          renderSession(msg.session);
        } else if (msg.type === 'frame') {
          errorEl.classList.remove('visible');
          errorEl.textContent = '';
          imgEl.src = msg.dataUrl;
          imgEl.classList.add('visible');
          emptyEl.style.display = 'none';
          lastAt = msg.at;
          renderUpdated();
        } else if (msg.type === 'error') {
          errorEl.textContent = String(msg.message);
          errorEl.classList.add('visible');
        }
      });

      btnPause.addEventListener('click', function () {
        paused = !paused;
        btnPause.textContent = paused ? 'Resume' : 'Pause';
        vscode.postMessage({ type: paused ? 'pause' : 'resume' });
      });
      btnRefresh.addEventListener('click', function () {
        vscode.postMessage({ type: 'refresh' });
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`
}
