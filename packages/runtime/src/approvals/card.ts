/**
 * The `ui_card` channel's HTML: self-contained, no-network MCP Apps pages
 * served as `ui://agentproto/approval/pending` (every pending approval) and
 * `ui://agentproto/approval/<id>` (one approval).
 *
 * Both are templates. A host may read a `ui://` resource once per connection
 * and reuse that HTML on every later tool call, so the HTML holds no approval
 * data and no ticket. After the `ui/initialize` handshake the page asks the
 * app-only `approval_card_list` tool for the cards (each with a freshly minted
 * one-time ticket) and renders them itself, again on every
 * `ui/notifications/tool-result`, after each decision and every 30 s while
 * visible. A ticket therefore exists only in the page's memory and is only
 * ever returned by that app-only tool.
 */

export function approvalCardResourceUri(id: string): string {
  return `ui://agentproto/approval/${id}`
}

const MSG_NOT_WAITING = "This request is no longer waiting for a decision."
const MSG_EXPIRED = "This card was refreshed. Click again to decide."
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
  .status { margin-top: 8px; font-size: 12px; color: var(--ap-muted); }
  .status:empty { display: none; }
  #note:empty { display: none; }
  .card + .card { border-top: 1px solid var(--ap-border); margin-top: 12px; padding-top: 12px; }
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
  var onToolResult = null;

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
    } else if (msg.method === 'ui/notifications/tool-result') {
      if (typeof onToolResult === 'function') onToolResult();
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

  function connect(onReady, onFail) {
    initBridge().then(function () {
      if (onReady) onReady();
      startSizing();
    }, function () {
      if (onFail) onFail();
      startSizing();
    });
  }
`


function pageScript(body: string): string {
  return `<script>\n(function () {${BRIDGE_JS}${body}})();\n</script>`
}

/** JSON safe to inline in a `<script>` block. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(new RegExp("\\u2028", "g"), "\\u2028")
    .replace(new RegExp("\\u2029", "g"), "\\u2029")
}

const MSG_NOTHING_TO_APPROVE = "Nothing to approve"
const MSG_LOADING = "Loading"
const MSG_LOAD_FAILED = "Could not load. Try again."

/** Rows kept per card and nesting followed when flattening a preview. */
const MAX_ROWS = 40
const MAX_DEPTH = 4
/** Values longer than this carry their full text in a tooltip and a visually
 *  hidden span (the clipped copy is aria-hidden to avoid reading it twice). */
const TITLE_MIN_LENGTH = 80
const REFRESH_MS = 30_000

/** The widget behind the model-visible `approval_pending` tool: every
 *  pending approval as its own card. Not an approval id. */
export const APPROVAL_PENDING_RESOURCE_URI = approvalCardResourceUri("pending")

/**
 * The one page script behind both card resources. Everything that comes from
 * an approval is written with `textContent`, never `innerHTML`. Plain ES5.
 * `String.raw` keeps its regex and escape sequences literal.
 */
function cardPageJs(approvalId: string | null): string {
  return String.raw`
  var APPROVAL_ID = ${scriptJson(approvalId)};
  var ERROR_RULES = ${scriptJson(ERROR_RULES)};
  var MSG_GENERIC = ${scriptJson(MSG_GENERIC)};
  var MSG_NOT_WAITING = ${scriptJson(MSG_NOT_WAITING)};
  var MSG_NOTHING = ${scriptJson(MSG_NOTHING_TO_APPROVE)};
  var MSG_LOAD_FAILED = ${scriptJson(MSG_LOAD_FAILED)};
  var MAX_ROWS = ${MAX_ROWS};
  var MAX_DEPTH = ${MAX_DEPTH};
  var TITLE_MIN_LENGTH = ${TITLE_MIN_LENGTH};
  var REFRESH_MS = ${REFRESH_MS};
  var FINAL_TEXT = { approved: 'Approved', consumed: 'Approved', denied: 'Refused', expired: 'Expired' };

  var _ready = false;
  var _cards = {};
  var _order = [];
  var _deciding = 0;
  var _refreshSeq = 0;
  var _container = document.getElementById('cards');
  var _note = document.getElementById('note');

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
  }

  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function humanizeKey(key) {
    var words = String(key)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_.-]+/g, ' ')
      .replace(/ +/g, ' ')
      .trim()
      .toLowerCase();
    return words.length === 0 ? 'Value' : words.charAt(0).toUpperCase() + words.slice(1);
  }

  function scalarText(v) {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number') return String(v);
    return undefined;
  }

  function flattenRows(value, label, depth, out) {
    if (out.length >= MAX_ROWS) return;
    var scalar = scalarText(value);
    if (scalar !== undefined) { out.push([label, scalar]); return; }
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      var allScalar = true;
      for (var i = 0; i < value.length; i++) if (scalarText(value[i]) === undefined) allScalar = false;
      if (allScalar) {
        var parts = [];
        for (var j = 0; j < value.length; j++) parts.push(scalarText(value[j]));
        out.push([label, parts.join(', ')]);
        return;
      }
      for (var k = 0; k < value.length; k++) flattenRows(value[k], label + ' ' + (k + 1), depth + 1, out);
      return;
    }
    if (isObj(value)) {
      if (depth >= MAX_DEPTH) return;
      var keys = Object.keys(value);
      for (var n = 0; n < keys.length; n++) {
        flattenRows(value[keys[n]], label ? label + ' / ' + humanizeKey(keys[n]) : humanizeKey(keys[n]), depth + 1, out);
      }
    }
  }

  function humanSize(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return Math.round(bytes) + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1).replace(/\.0$/, '') + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' MB';
  }

  function addressList(v) {
    if (Array.isArray(v)) {
      var out = [];
      for (var i = 0; i < v.length; i++) {
        var t = scalarText(v[i]);
        if (t) out.push(t);
      }
      return out.join(', ');
    }
    return scalarText(v) || '';
  }

  function addRow(dl, key, value) {
    dl.appendChild(node('dt', '', key));
    var dd = node('dd');
    if (value.length > TITLE_MIN_LENGTH || value.indexOf('\n') >= 0) {
      dd.setAttribute('title', value);
      var clipped = node('span', '', value);
      clipped.setAttribute('aria-hidden', 'true');
      dd.appendChild(clipped);
      dd.appendChild(node('span', 'sr-only', value));
    } else {
      dd.textContent = value;
    }
    dl.appendChild(dd);
  }

  function renderMail(preview) {
    var wrap = node('div');
    var head = node('dl', 'mail');
    addRow(head, 'To', addressList(preview.to));
    var cc = addressList(preview.cc);
    if (cc.length > 0) addRow(head, 'Cc', cc);
    addRow(head, 'Subject', scalarText(preview.subject) || '');
    wrap.appendChild(head);
    wrap.appendChild(node('div', 'body', scalarText(preview.body) || ''));
    var names = [];
    if (Array.isArray(preview.attachments)) {
      for (var i = 0; i < preview.attachments.length; i++) {
        var a = preview.attachments[i];
        if (!isObj(a)) continue;
        var name = scalarText(a.fileName) || '';
        var size = humanSize(a.sizeBytes);
        names.push(size ? name + ' (' + size + ')' : name);
      }
    }
    if (names.length > 0) {
      var box = node('div', 'attachments');
      box.appendChild(node('div', 'label', 'Attachments'));
      var ul = node('ul');
      for (var j = 0; j < names.length; j++) ul.appendChild(node('li', '', names[j]));
      box.appendChild(ul);
      wrap.appendChild(box);
    }
    return wrap;
  }

  function renderPreview(preview) {
    if (isObj(preview) && preview.kind === 'mail') return renderMail(preview);
    var rows = [];
    if (isObj(preview)) {
      var keys = Object.keys(preview);
      for (var i = 0; i < keys.length; i++) flattenRows(preview[keys[i]], humanizeKey(keys[i]), 1, rows);
    } else {
      flattenRows(preview, 'Details', 1, rows);
    }
    if (rows.length === 0) return null;
    var dl = node('dl', 'list');
    for (var j = 0; j < rows.length; j++) addRow(dl, rows[j][0], rows[j][1]);
    return dl;
  }

  function syncButtons(card) {
    var off = !_ready || !card.ticket || card.busy;
    card.approveBtn.disabled = off;
    card.denyBtn.disabled = off;
  }

  function setNote(text) {
    _note.textContent = text;
  }

  function showFinal(card, status) {
    card.final = true;
    card.ticket = '';
    card.actions.style.display = 'none';
    card.meta.textContent = '';
    card.statusEl.textContent = FINAL_TEXT[status] || MSG_NOT_WAITING;
  }

  function updateExpiry() {
    for (var i = 0; i < _order.length; i++) {
      var card = _cards[_order[i]];
      if (card.final) continue;
      var at = card.expiresAt ? Date.parse(card.expiresAt) : NaN;
      card.meta.textContent = isNaN(at) ? '' : expiryText(at - Date.now());
    }
  }

  function buildCard(item) {
    var el = node('section', 'card');
    el.appendChild(node('h3', '', item.title === undefined ? '' : String(item.title)));
    var preview = renderPreview(item.preview);
    if (preview) el.appendChild(preview);
    var card = {
      id: item.id, el: el, ticket: '', expiresAt: '', busy: false, final: false, remembered: false,
      meta: node('div', 'meta'), actions: node('div', 'actions'),
      denyBtn: node('button', '', 'Refuse'), approveBtn: node('button', 'primary', 'Approve'),
      statusEl: node('div', 'status')
    };
    card.statusEl.setAttribute('role', 'status');
    card.denyBtn.disabled = true;
    card.approveBtn.disabled = true;
    card.denyBtn.addEventListener('click', function () { decide(card, 'deny'); });
    card.approveBtn.addEventListener('click', function () { decide(card, 'approve'); });
    card.actions.appendChild(card.denyBtn);
    card.actions.appendChild(card.approveBtn);
    el.appendChild(card.meta);
    el.appendChild(card.actions);
    el.appendChild(card.statusEl);
    return card;
  }

  function dropCard(id) {
    var card = _cards[id];
    if (!card) return;
    card.el.remove();
    delete _cards[id];
    _order.splice(_order.indexOf(id), 1);
  }

  function showEmptyNote() {
    setNote(_order.length === 0 ? (APPROVAL_ID ? MSG_NOT_WAITING : MSG_NOTHING) : '');
  }

  function applyList(items) {
    var seen = {};
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!isObj(item) || typeof item.id !== 'string') continue;
      seen[item.id] = true;
      var card = _cards[item.id];
      if (!card) {
        card = buildCard(item);
        _cards[item.id] = card;
        _order.push(item.id);
        _container.appendChild(card.el);
      }
      card.expiresAt = typeof item.expiresAt === 'string' ? item.expiresAt : '';
      if (item.status && item.status !== 'pending') {
        showFinal(card, item.status);
      } else {
        if (card.remembered) {
          card.remembered = false;
          card.final = false;
          card.actions.style.display = '';
          card.statusEl.textContent = '';
        }
        card.ticket = typeof item.ticket === 'string' ? item.ticket : '';
      }
      syncButtons(card);
    }
    var ids = _order.slice();
    for (var j = 0; j < ids.length; j++) if (!seen[ids[j]] && !_cards[ids[j]].remembered) dropCard(ids[j]);
    showEmptyNote();
    updateExpiry();
    reportSize();
  }

  function refresh() {
    if (!_ready || _deciding > 0) return Promise.resolve();
    var seq = ++_refreshSeq;
    return callTool('approval_card_list', APPROVAL_ID ? { approvalId: APPROVAL_ID } : {}).then(function (result) {
      if (seq !== _refreshSeq || _deciding > 0) return;
      var data = result && result.structuredContent;
      applyList(data && Array.isArray(data.approvals) ? data.approvals : []);
    }, function () {
      if (_order.length === 0) { setNote(MSG_LOAD_FAILED); reportSize(); }
    });
  }

  function decide(card, decision) {
    if (card.busy || !card.ticket || !_ready) return;
    card.busy = true;
    _deciding++;
    card.statusEl.textContent = '';
    syncButtons(card);
    callTool('approval_card_decide', { approvalId: card.id, decision: decision, ticket: card.ticket }).then(function () {
      _deciding--;
      card.busy = false;
      showFinal(card, decision === 'approve' ? 'approved' : 'denied');
      if (!APPROVAL_ID) card.remembered = true;
      showEmptyNote();
      reportSize();
      refresh();
    }, function (err) {
      _deciding--;
      var text = humanize(err);
      card.statusEl.textContent = text;
      reportSize();
      if (text === MSG_GENERIC) { card.busy = false; syncButtons(card); return; }
      refresh().then(function () { card.busy = false; syncButtons(card); reportSize(); });
    });
  }

  onToolResult = function () { refresh(); };
  setNote(${scriptJson(MSG_LOADING)});
  setInterval(function () {
    updateExpiry();
    if (document.visibilityState !== 'hidden') refresh();
  }, REFRESH_MS);
  connect(function () { _ready = true; refresh(); }, function () { setNote(MSG_LOAD_FAILED); });
`
}

const CARD_PAGE_HEAD = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>${PAGE_STYLE}</style>
</head>
<body>
<div id="cards"></div>
<p id="note"></p>
`

function cardPageHtml(approvalId: string | null): string {
  return `${CARD_PAGE_HEAD}${pageScript(cardPageJs(approvalId))}
</body>
</html>`
}

/**
 * The template behind `ui://agentproto/approval/pending`: one card per
 * pending approval, fetched live by the page. Holds no approval data and no
 * ticket, so a host that caches it still shows the current list.
 */
export function renderPendingApprovalsHtml(): string {
  return cardPageHtml(null)
}

/**
 * The template behind `ui://agentproto/approval/<id>`: the same page,
 * targeting one approval. It differs from the pending page only by that id.
 * Holds no approval data and no ticket.
 */
export function renderApprovalCardHtml(approvalId: string): string {
  return cardPageHtml(approvalId)
}
