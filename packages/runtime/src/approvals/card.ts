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

/** Values long enough to be clipped to 3 lines carry their full text in a
 *  tooltip and in a visually hidden span, so assistive tech reads the whole
 *  value (the clipped copy is aria-hidden to avoid reading it twice). */
const TITLE_MIN_LENGTH = 80

function ddHtml(value: string): string {
  if (value.length > TITLE_MIN_LENGTH || value.includes("\n")) {
    return `<dd title="${escHtml(value)}"><span aria-hidden="true">${escHtml(value)}</span><span class="sr-only">${escHtml(value)}</span></dd>`
  }
  return `<dd>${escHtml(value)}</dd>`
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
  const head = rows.map(([k, v]) => `<dt>${escHtml(k)}</dt>${ddHtml(v)}`).join("")
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
    .map(([k, v]) => `<dt>${escHtml(k)}</dt>${ddHtml(v)}`)
    .join("")}</dl>`
}


/** Colours come from the host's MCP Apps CSS variables when it sends them,
 *  else from the host theme (`data-theme`, set by the script), else from
 *  `prefers-color-scheme`. The body stays transparent so the card sits in the
 *  chat instead of in a box of its own. */
const PAGE_STYLE = `
  :root { color-scheme: light; --ap-fg-d: #1a1a1a; --ap-muted-d: #6b6b6b; --ap-border-d: #e2e2e2; --ap-bg-d: #ffffff; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { color-scheme: dark; --ap-fg-d: #ececec; --ap-muted-d: #9a9a9a; --ap-border-d: #3a3a3a; --ap-bg-d: #1c1c1c; }
  }
  :root[data-theme="dark"] { color-scheme: dark; --ap-fg-d: #ececec; --ap-muted-d: #9a9a9a; --ap-border-d: #3a3a3a; --ap-bg-d: #1c1c1c; }
  :root {
    --ap-fg: var(--color-text-primary, var(--ap-fg-d));
    --ap-muted: var(--color-text-secondary, var(--ap-muted-d));
    --ap-border: var(--color-border-primary, var(--ap-border-d));
    --ap-bg: var(--color-background-primary, var(--ap-bg-d));
    --ap-font: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  }
  html, body { background: transparent; }
  body { font-family: var(--ap-font); font-size: 13px; line-height: 1.45; margin: 0; padding: 12px; color: var(--ap-fg); }
  h3 { margin: 0 0 8px; font-size: 14px; font-weight: 500; }
  p { margin: 0; color: var(--ap-muted); }
  dl { display: grid; grid-template-columns: minmax(72px, 28%) 1fr; gap: 4px 12px; margin: 0 0 8px; }
  dt { color: var(--ap-muted); }
  dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; }
  .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
  .body { border-top: 1px solid var(--ap-border); border-bottom: 1px solid var(--ap-border); padding: 8px 0; margin: 0 0 8px; max-height: 10em; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  .attachments { margin: 0 0 8px; }
  .attachments .label { color: var(--ap-muted); margin-bottom: 2px; }
  .attachments ul { margin: 0; padding-left: 18px; }
  .meta { font-size: 11px; color: var(--ap-muted); margin: 0; }
  .meta:empty { display: none; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
  button { font: inherit; font-size: 12px; padding: 4px 12px; border: 1px solid var(--ap-border); border-radius: 6px; background: transparent; color: var(--ap-fg); cursor: pointer; }
  button.primary { background: var(--ap-fg); border-color: var(--ap-fg); color: var(--ap-bg); }
  button:focus-visible { outline: 2px solid var(--ap-fg); outline-offset: 2px; }
  button:disabled { opacity: 0.5; cursor: default; }
  #status { margin-top: 8px; font-size: 12px; color: var(--ap-muted); }
  #status:empty { display: none; }
`

/**
 * The MCP Apps JSON-RPC-over-postMessage bridge shared by every card page
 * (same wire shape as `terminal-panel-app.ts` / `sessions-panel.ts`): the
 * `ui/initialize` handshake, the host theme (`hostContext.theme` and
 * `hostContext.styles.variables`, also on `host-context-changed`), and
 * `ui/notifications/size-changed` so the host sizes its frame to the content
 * instead of keeping a default height. Plain ES5, no interpolation.
 */
const BRIDGE_JS = `
  var _nextId = 1;
  var _pending = {};
  var _appliedVars = [];
  var _hostContext = {};
  var _lastHeight = -1;
  var _sizing = false;

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

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function assign(target, source) {
    for (var k in source) {
      if (Object.prototype.hasOwnProperty.call(source, k)) target[k] = source[k];
    }
    return target;
  }

  function mergeHostContext(prev, patch) {
    var next = assign(assign({}, prev), patch);
    if (isObj(patch.styles)) {
      var prevStyles = isObj(prev.styles) ? prev.styles : {};
      next.styles = assign(assign({}, prevStyles), patch.styles);
      if (isObj(patch.styles.variables)) {
        var prevVars = isObj(prevStyles.variables) ? prevStyles.variables : {};
        next.styles.variables = assign(assign({}, prevVars), patch.styles.variables);
      }
    }
    return next;
  }

  function applyHostContext(patch) {
    if (!isObj(patch)) return;
    _hostContext = mergeHostContext(_hostContext, patch);
    var root = document.documentElement;
    if (_hostContext.theme === 'light' || _hostContext.theme === 'dark') root.setAttribute('data-theme', _hostContext.theme);
    for (var i = 0; i < _appliedVars.length; i++) root.style.removeProperty(_appliedVars[i]);
    _appliedVars = [];
    var vars = isObj(_hostContext.styles) ? _hostContext.styles.variables : undefined;
    if (!isObj(vars)) return;
    for (var key in vars) {
      if (!Object.prototype.hasOwnProperty.call(vars, key)) continue;
      var value = vars[key];
      if (!/^--[a-z0-9-]+$/i.test(key) || typeof value !== 'string' || value === '') continue;
      root.style.setProperty(key, value);
      _appliedVars.push(key);
    }
  }

  function reportSize() {
    if (!_sizing) return;
    var height = Math.ceil(document.body.getBoundingClientRect().height);
    if (!(height > 0) || height === _lastHeight) return;
    _lastHeight = height;
    rpcNotify('ui/notifications/size-changed', { height: height });
  }

  function startSizing() {
    _sizing = true;
    reportSize();
    if (typeof ResizeObserver === 'function') new ResizeObserver(reportSize).observe(document.body);
  }

  window.addEventListener('message', function (evt) {
    if (evt.source !== window.parent) return;
    var msg = evt.data;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    if (msg.id != null && msg.method == null) {
      var p = _pending[msg.id];
      if (!p) return;
      delete _pending[msg.id];
      if (msg.error) p.reject(new Error(msg.error.message || 'rpc error ' + msg.error.code));
      else p.resolve(msg.result);
    } else if (msg.method === 'ui/notifications/host-context-changed') {
      applyHostContext(msg.params);
      reportSize();
    }
  });

  function initBridge() {
    return rpcRequest('ui/initialize', {
      appInfo: { name: 'agentproto-approval-card', version: '0.1.0' },
      appCapabilities: { availableDisplayModes: ['inline'] },
      protocolVersion: '2026-01-26'
    }).then(function (result) {
      applyHostContext(result && result.hostContext);
      rpcNotify('ui/notifications/initialized', {});
    });
  }

  function connect(onReady) {
    initBridge().then(function () {
      if (onReady) onReady();
      startSizing();
    }, startSizing);
  }
`

function pageScript(body: string): string {
  return `<script>\n(function () {${BRIDGE_JS}${body}})();\n</script>`
}

/** Static HTML for a state with nothing to decide. Still self-contained and
 *  network-free; it still reports its size so the host shrinks the frame. */
function messageHtml(title: string | undefined, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_STYLE}</style></head><body>
${title === undefined ? "" : `<h3>${escHtml(title)}</h3>`}
<p>${escHtml(message)}</p>
${pageScript("\n  connect();\n")}
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

/** The earlier of the approval's own expiry and the card ticket's, as an ISO
 *  string the in-page script turns into "expires in 12 min". */
function earliestExpiry(...candidates: Array<string | undefined>): string | undefined {
  let best: { iso: string; ms: number } | undefined
  for (const iso of candidates) {
    if (iso === undefined) continue
    const ms = Date.parse(iso)
    if (Number.isNaN(ms)) continue
    if (best === undefined || ms < best.ms) best = { iso, ms }
  }
  return best?.iso
}

/** Script pieces every card page needs: the error table, the `tools/call`
 *  wrapper, error humanizing and the relative-expiry text. Shared by the
 *  single-card page and the pending-list page so they cannot drift. */
function cardSharedJs(): string {
  return `var ERROR_RULES = ${scriptJson(ERROR_RULES)};
  var MSG_GENERIC = ${scriptJson(MSG_GENERIC)};

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

  function expiryText(ms) {
    var mins = Math.ceil(ms / 60000);
    if (mins <= 0) return 'expired';
    if (mins < 60) return 'expires in ' + mins + ' min';
    var hours = Math.round(mins / 60);
    if (hours < 24) return 'expires in ' + hours + ' h';
    return 'expires in ' + Math.round(hours / 24) + ' d';
  }`
}

/** The widget behind the model-visible `approval_pending` tool: every
 *  pending approval as its own card. Not an approval id. */
export const APPROVAL_PENDING_RESOURCE_URI = approvalCardResourceUri("pending")

const MSG_NOTHING_TO_APPROVE = "Nothing to approve"

const PENDING_STYLE = `
  .card + .card { border-top: 1px solid var(--ap-border); margin-top: 12px; padding-top: 12px; }
  .card .status { margin-top: 8px; font-size: 12px; color: var(--ap-muted); }
  .card .status:empty { display: none; }
`

/**
 * One card per pending approval, each with its own freshly minted one-time
 * ticket (inline in the script only, like the single card). Deciding a card
 * calls `approval_card_decide` exactly as the single card does, then drops
 * that card. With nothing pending it is the "Nothing to approve" page.
 */
export function renderPendingApprovalsHtml(engine: ApprovalsEngine): string {
  const cards: Array<{ record: ApprovalRecord; ticket: string; expiresAt: string | undefined }> = []
  for (const record of engine.list({ status: "pending" })) {
    try {
      const { ticket, expiresAt } = engine.mintCardTicket(record.id)
      cards.push({ record, ticket, expiresAt: earliestExpiry(record.expiresAt, expiresAt) })
    } catch {
      // Decided or expired between the list and the mint: nothing to show.
    }
  }
  if (cards.length === 0) return messageHtml(undefined, MSG_NOTHING_TO_APPROVE)

  const markup = cards
    .map(({ record, expiresAt }, i) => {
      const expiryAttr = expiresAt === undefined ? "" : ` data-expires="${escHtml(expiresAt)}"`
      return `<section class="card" id="card-${i}">
<h3>${escHtml(record.title)}</h3>
${renderPreview(record)}
<div class="meta" id="expiry-${i}"${expiryAttr}></div>
<div class="actions" id="actions-${i}">
  <button id="deny-${i}" disabled>Refuse</button>
  <button id="approve-${i}" class="primary" disabled>Approve</button>
</div>
<div class="status" id="status-${i}" role="status"></div>
</section>`
    })
    .join("\n")

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>${PAGE_STYLE}${PENDING_STYLE}</style>
</head>
<body>
${markup}
<p id="empty" hidden>${escHtml(MSG_NOTHING_TO_APPROVE)}</p>
${pageScript(`
  var CARDS = ${scriptJson(cards.map(c => ({ id: c.record.id, ticket: c.ticket })))};
  var _left = CARDS.length;
  ${cardSharedJs()}

  function setBusy(i, busy) {
    document.getElementById('approve-' + i).disabled = busy;
    document.getElementById('deny-' + i).disabled = busy;
  }

  function updateExpiry() {
    for (var i = 0; i < CARDS.length; i++) {
      var el = document.getElementById('expiry-' + i);
      if (!el) continue;
      var at = Date.parse(el.getAttribute('data-expires') || '');
      if (!isNaN(at)) el.textContent = expiryText(at - Date.now());
    }
    reportSize();
  }

  var _expiryTimer = setInterval(updateExpiry, 30000);

  function decide(i, decision) {
    var status = document.getElementById('status-' + i);
    setBusy(i, true);
    callTool('approval_card_decide', { approvalId: CARDS[i].id, decision: decision, ticket: CARDS[i].ticket })
      .then(function () {
        document.getElementById('card-' + i).remove();
        _left--;
        if (_left === 0) {
          clearInterval(_expiryTimer);
          document.getElementById('empty').hidden = false;
        }
        reportSize();
      })
      .catch(function (err) {
        status.textContent = humanize(err);
        setBusy(i, false);
        reportSize();
      });
  }

  CARDS.forEach(function (_card, i) {
    document.getElementById('approve-' + i).addEventListener('click', function () { decide(i, 'approve'); });
    document.getElementById('deny-' + i).addEventListener('click', function () { decide(i, 'deny'); });
  });

  updateExpiry();
  connect(function () {
    for (var i = 0; i < CARDS.length; i++) setBusy(i, false);
  });
`)}
</body>
</html>`
}

/**
 * Render the card HTML for `approvalId`, minting a fresh one-time ticket
 * when the approval is still `pending`. Title, preview (key/value lines),
 * and two buttons (Approve / Refuse) that call the app-only
 * `approval_card_decide` tool over the standard MCP Apps
 * `window.parent.postMessage` JSON-RPC bridge, with no other network access.
 */
export function renderApprovalCardHtml(engine: ApprovalsEngine, approvalId: string): string {
  const record = engine.get(approvalId)
  if (!record) return notFoundHtml()
  if (record.status !== "pending") return decidedHtml(record)

  const { ticket, expiresAt: ticketExpiresAt } = engine.mintCardTicket(approvalId)
  const expiresAt = earliestExpiry(record.expiresAt, ticketExpiresAt)
  const expiryAttr = expiresAt === undefined ? "" : ` data-expires="${escHtml(expiresAt)}"`

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>${PAGE_STYLE}</style>
</head>
<body>
<h3>${escHtml(record.title)}</h3>
${renderPreview(record)}
<div class="meta" id="expiry"${expiryAttr}></div>
<div class="actions" id="actions">
  <button id="deny" disabled>Refuse</button>
  <button id="approve" class="primary" disabled>Approve</button>
</div>
<div id="status" role="status"></div>
${pageScript(`
  var TICKET = ${scriptJson(ticket)};
  var APPROVAL_ID = ${scriptJson(approvalId)};
  ${cardSharedJs()}

  function setStatus(text) {
    document.getElementById('status').textContent = text;
    reportSize();
  }

  function setBusy(busy) {
    document.getElementById('approve').disabled = busy;
    document.getElementById('deny').disabled = busy;
  }

  var _expiryTimer = null;

  function updateExpiry() {
    var el = document.getElementById('expiry');
    var at = Date.parse(el.getAttribute('data-expires') || '');
    if (isNaN(at)) return;
    el.textContent = expiryText(at - Date.now());
    reportSize();
  }

  function decide(decision) {
    setBusy(true);
    callTool('approval_card_decide', { approvalId: APPROVAL_ID, decision: decision, ticket: TICKET })
      .then(function () {
        if (_expiryTimer !== null) clearInterval(_expiryTimer);
        document.getElementById('actions').style.display = 'none';
        document.getElementById('expiry').style.display = 'none';
        setStatus(decision === 'approve' ? 'Approved' : 'Refused');
      })
      .catch(function (err) {
        setStatus(humanize(err));
        setBusy(false);
      });
  }

  document.getElementById('approve').addEventListener('click', function () { decide('approve'); });
  document.getElementById('deny').addEventListener('click', function () { decide('deny'); });

  updateExpiry();
  _expiryTimer = setInterval(updateExpiry, 30000);
  connect(function () { setBusy(false); });
`)}
</body>
</html>`
}
