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
    .replace(/'/g, "&#39;")
}

const MSG_NOT_WAITING = "This request is no longer waiting for a decision."
const MSG_EXPIRED = "This card has expired. Open it again to decide."
const MSG_GENERIC = "Something went wrong. Try again."

/** Ordered `[regex source, message]` rules. The same table is inlined into
 *  the card's script, so the server-rendered states and the in-page error
 *  handling can never drift. */
const ERROR_RULES: ReadonlyArray<readonly [string, string]> = [
  ["ticket", MSG_EXPIRED],
  ["not pending|already|not found|no approval|not approved|expired before|was not", MSG_NOT_WAITING],
]

/** Map any engine error text to plain copy. Never echoes the input. */
export function humanizeApprovalError(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : ""
  for (const [source, message] of ERROR_RULES) {
    if (new RegExp(source, "i").test(text)) return message
  }
  return MSG_GENERIC
}

const MAX_ROWS = 40
const MAX_DEPTH = 4

/** "invoiceNumber" / "invoice_number" -> "Invoice number". */
function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
  return words.length === 0 ? "Value" : words.charAt(0).toUpperCase() + words.slice(1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function scalarText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "number" || typeof value === "bigint") return String(value)
  return undefined
}

/** Flatten any value into label/value rows. Nested labels are joined with " / ". */
function flattenRows(value: unknown, label: string, depth: number, out: Array<[string, string]>): void {
  if (out.length >= MAX_ROWS) return
  const scalar = scalarText(value)
  if (scalar !== undefined) {
    out.push([label, scalar])
    return
  }
  if (value === null || value === undefined) return
  if (Array.isArray(value)) {
    if (value.length === 0) return
    const allScalar = value.every(item => scalarText(item) !== undefined)
    if (allScalar) {
      out.push([label, value.map(item => scalarText(item) ?? "").join(", ")])
      return
    }
    value.forEach((item, index) => {
      flattenRows(item, `${label} ${index + 1}`, depth + 1, out)
    })
    return
  }
  if (isRecord(value)) {
    if (depth >= MAX_DEPTH) return
    for (const [key, child] of Object.entries(value)) {
      flattenRows(child, label ? `${label} / ${humanizeKey(key)}` : humanizeKey(key), depth + 1, out)
    }
  }
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`
}

function addressList(value: unknown): string {
  if (Array.isArray(value)) return value.map(v => scalarText(v) ?? "").filter(s => s.length > 0).join(", ")
  return scalarText(value) ?? ""
}

function renderMail(preview: Record<string, unknown>): string {
  const to = addressList(preview.to)
  const cc = addressList(preview.cc)
  const subject = scalarText(preview.subject) ?? ""
  const body = scalarText(preview.body) ?? ""
  const attachments = Array.isArray(preview.attachments)
    ? preview.attachments.filter(isRecord).map(a => {
        const name = scalarText(a.fileName) ?? ""
        const size = typeof a.sizeBytes === "number" ? humanSize(a.sizeBytes) : ""
        return size ? `${name} (${size})` : name
      })
    : []
  const rows: Array<[string, string]> = []
  rows.push(["To", to])
  if (cc.length > 0) rows.push(["Cc", cc])
  rows.push(["Subject", subject])
  const head = rows.map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd>`).join("")
  const attach =
    attachments.length > 0
      ? `<div class="attachments"><div class="label">Attachments</div><ul>${attachments
          .map(a => `<li>${escHtml(a)}</li>`)
          .join("")}</ul></div>`
      : ""
  return `<dl class="mail">${head}</dl><div class="body">${escHtml(body)}</div>${attach}`
}

function renderPreview(record: ApprovalRecord): string {
  const preview = record.preview
  if (isRecord(preview) && preview.kind === "mail") return renderMail(preview)
  const rows: Array<[string, string]> = []
  if (isRecord(preview)) {
    for (const [key, value] of Object.entries(preview)) flattenRows(value, humanizeKey(key), 1, rows)
  } else {
    flattenRows(preview, "Details", 1, rows)
  }
  if (rows.length === 0) return ""
  return `<dl class="list">${rows
    .map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd>`)
    .join("")}</dl>`
}

const PAGE_STYLE = `
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 16px; color: #111; }
  h3 { margin: 0 0 12px; font-size: 16px; }
  dl { display: grid; grid-template-columns: minmax(80px, 30%) 1fr; gap: 6px 12px; margin: 0 0 12px; font-size: 13px; }
  dt { color: #666; }
  dd { margin: 0; word-break: break-word; white-space: pre-wrap; }
  .body { border-top: 1px solid #eee; border-bottom: 1px solid #eee; padding: 10px 0; margin: 0 0 12px; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
  .attachments { font-size: 13px; margin: 0 0 12px; }
  .attachments .label { color: #666; margin-bottom: 4px; }
  .attachments ul { margin: 0; padding-left: 18px; }
  .actions { display: flex; gap: 8px; margin-top: 16px; }
  button { flex: 1; padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
  button:disabled { opacity: 0.5; cursor: default; }
  #approve { background: #16a34a; color: white; }
  #deny { background: #dc2626; color: white; }
  #status { margin-top: 12px; font-size: 13px; color: #444; min-height: 16px; }
`

/** Static HTML for a state with nothing to decide. Still self-contained and
 *  network-free. */
function messageHtml(title: string | undefined, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_STYLE}</style></head><body>
${title === undefined ? "" : `<h3>${escHtml(title)}</h3>`}
<p>${escHtml(message)}</p>
</body></html>`
}

function decidedHtml(record: ApprovalRecord): string {
  return messageHtml(record.title, MSG_NOT_WAITING)
}

function notFoundHtml(): string {
  return messageHtml(undefined, MSG_NOT_WAITING)
}

/** JSON safe to inline in a `<script>` block. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(new RegExp("\\u2028", "g"), "\\u2028")
    .replace(new RegExp("\\u2029", "g"), "\\u2029")
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
  if (!record) return notFoundHtml()
  if (record.status !== "pending") return decidedHtml(record)

  const { ticket } = engine.mintCardTicket(approvalId)

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>${PAGE_STYLE}</style>
</head>
<body>
<h3>${escHtml(record.title)}</h3>
${renderPreview(record)}
<div class="actions">
  <button id="approve">Approve</button>
  <button id="deny">Deny</button>
</div>
<div id="status" role="status"></div>
<script>
(function () {
  var TICKET = ${scriptJson(ticket)};
  var APPROVAL_ID = ${scriptJson(approvalId)};
  var ERROR_RULES = ${scriptJson(ERROR_RULES)};
  var MSG_GENERIC = ${scriptJson(MSG_GENERIC)};

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
        var errText = (result.content && result.content[0] && result.content[0].text) || '';
        throw new Error(errText);
      }
      return result;
    });
  }

  function humanize(err) {
    var text = err && err.message ? String(err.message) : '';
    for (var i = 0; i < ERROR_RULES.length; i++) {
      if (new RegExp(ERROR_RULES[i][0], 'i').test(text)) return ERROR_RULES[i][1];
    }
    return MSG_GENERIC;
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
        document.querySelector('.actions').style.display = 'none';
        setStatus(decision === 'approve' ? 'Approved' : 'Declined');
      })
      .catch(function (err) {
        setStatus(humanize(err));
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
