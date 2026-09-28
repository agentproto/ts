/**
 * The `ui_card` channel's HTML — a self-contained, no-network MCP Apps
 * panel served as `ui://agentproto/approval/<id>`. Its producer function
 * runs on EVERY `resources/read` (never once at registration): each read
 * mints a fresh one-time ticket via `ApprovalsEngine.mintCardTicket`,
 * which — by construction (`mintCardTicket` overwrites the single stored
 * ticket for that approval id) — invalidates whatever ticket an earlier
 * read handed out. The ticket lives ONLY in this HTML's inline `<script>`;
 * it is never returned from any tool call.
 */

import type { ApprovalsEngine } from "./engine.js"
import type { ApprovalRecord } from "./types.js"

export function approvalCardResourceUri(id: string): string {
  return `ui://agentproto/approval/${id}`
}

function escHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function previewRows(record: ApprovalRecord): string {
  const preview = record.preview
  if (preview === null || typeof preview !== "object" || Array.isArray(preview)) {
    return `<tr><td colspan="2">${escHtml(JSON.stringify(preview))}</td></tr>`
  }
  const entries = Object.entries(preview as Record<string, unknown>)
  if (entries.length === 0) return ""
  return entries
    .map(
      ([key, value]) =>
        `<tr><td>${escHtml(key)}</td><td>${escHtml(
          typeof value === "string" ? value : JSON.stringify(value),
        )}</td></tr>`,
    )
    .join("")
}

/** Static HTML for a non-pending approval — no ticket to mint, nothing to
 *  decide. Still self-contained and network-free. */
function decidedHtml(record: ApprovalRecord): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;padding:16px">
<h3>${escHtml(record.title)}</h3>
<p>This approval is already <strong>${escHtml(record.status)}</strong>.</p>
</body></html>`
}

function notFoundHtml(approvalId: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;padding:16px">
<p>Approval ${escHtml(approvalId)} was not found.</p>
</body></html>`
}

/**
 * Render the card HTML for `approvalId`, minting a fresh one-time ticket
 * when the approval is still `pending`. Title, preview (key/value table),
 * and two buttons (Approve / Deny) that call the app-only
 * `approval_card_decide` tool over the standard MCP Apps
 * `window.parent.postMessage` JSON-RPC bridge (same wire shape as
 * `terminal-panel-app.ts` / `sessions-panel.ts`) — no other network access.
 */
export function renderApprovalCardHtml(engine: ApprovalsEngine, approvalId: string): string {
  const record = engine.get(approvalId)
  if (!record) return notFoundHtml(approvalId)
  if (record.status !== "pending") return decidedHtml(record)

  const { ticket } = engine.mintCardTicket(approvalId)

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 16px; color: #111; }
  h3 { margin: 0 0 8px; font-size: 16px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
  td { padding: 4px 8px; border-bottom: 1px solid #eee; font-size: 13px; word-break: break-word; vertical-align: top; }
  td:first-child { color: #666; width: 35%; }
  .actions { display: flex; gap: 8px; }
  button { flex: 1; padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
  button:disabled { opacity: 0.5; cursor: default; }
  #approve { background: #16a34a; color: white; }
  #deny { background: #dc2626; color: white; }
  #status { margin-top: 12px; font-size: 13px; color: #666; min-height: 16px; }
</style>
</head>
<body>
<h3>${escHtml(record.title)}</h3>
<table>${previewRows(record)}</table>
<div class="actions">
  <button id="approve">Approve</button>
  <button id="deny">Deny</button>
</div>
<div id="status"></div>
<script>
(function () {
  var TICKET = ${JSON.stringify(ticket)};
  var APPROVAL_ID = ${JSON.stringify(approvalId)};

  // ============================================================
  // MCP Apps bridge — JSON-RPC 2.0 over window.parent.postMessage.
  // Same wire shape as terminal-panel-app.ts / sessions-panel.ts.
  // ============================================================
  var _nextId = 1;
  var _pending = {};

  function post(msg) { window.parent.postMessage(msg, '*'); }

  function rpcRequest(method, params) {
    return new Promise(function (resolve, reject) {
      var id = _nextId++;
      _pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
    });
  }

  function rpcNotify(method, params) {
    post({ jsonrpc: '2.0', method: method, params: params || {} });
  }

  window.addEventListener('message', function (evt) {
    var msg = evt.data;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    if (msg.id != null && msg.method == null) {
      var p = _pending[msg.id];
      if (!p) return;
      delete _pending[msg.id];
      if (msg.error) p.reject(new Error(msg.error.message || 'rpc error ' + msg.error.code));
      else p.resolve(msg.result);
    }
  });

  function initBridge() {
    return rpcRequest('ui/initialize', {
      capabilities: {},
      clientInfo: { name: 'agentproto-approval-card', version: '0.1.0' },
      protocolVersion: '2026-01-26',
      appCapabilities: { tools: { listChanged: false }, availableDisplayModes: ['inline'] }
    }).then(function () { rpcNotify('ui/notifications/initialized', {}); });
  }

  function callTool(name, args) {
    return rpcRequest('tools/call', { name: name, arguments: args || {} }).then(function (result) {
      if (result && result.isError) {
        var errText = (result.content && result.content[0] && result.content[0].text) || 'tool error';
        throw new Error(errText);
      }
      return result;
    });
  }

  function setStatus(text) {
    document.getElementById('status').textContent = text;
  }

  function setBusy(busy) {
    document.getElementById('approve').disabled = busy;
    document.getElementById('deny').disabled = busy;
  }

  function decide(decision) {
    setBusy(true);
    callTool('approval_card_decide', { approvalId: APPROVAL_ID, decision: decision, ticket: TICKET })
      .then(function () {
        setStatus(decision === 'approve' ? 'Approved.' : 'Denied.');
      })
      .catch(function (err) {
        setStatus('Error: ' + err.message);
        setBusy(false);
      });
  }

  document.getElementById('approve').addEventListener('click', function () { decide('approve'); });
  document.getElementById('deny').addEventListener('click', function () { decide('deny'); });

  initBridge();
})();
</script>
</body>
</html>`
}
