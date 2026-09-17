/**
 * Blob pass-through for the session-chat widget (see ./panel.ts `mountBlob`).
 *
 * Claude Desktop and Codex apply their own CSP to an MCP-Apps widget frame:
 * `frame-src 'self' blob: data:`. Neither merges the resource's declared
 * `_meta.ui.csp.frameDomains` into it (measured 2026-09-18), so a direct
 * `<iframe src="http://127.0.0.1:18790/apps/@agentik/session-chat/ui?…">` is
 * refused host-side before the request ever reaches the daemon. `blob:` IS
 * on that list — so the panel fetches the chat html itself (a fetch, not a
 * frame navigation; the per-boot `?et=` embed token gets it through the
 * daemon's origin gates and PNA preflight), rewrites it with the function
 * below, and mounts the result as a `blob:` document.
 *
 * What the rewrite has to fix, given that the document no longer lives on
 * the daemon origin:
 *
 *   1. `<base href="<deep link>">` right after `<head>`, so every relative
 *      url in the app (the injected standalone bridge's `./tool-call`, any
 *      relative asset) resolves exactly as it would have on the daemon.
 *      NOTE: the base is the document url itself (`…/session-chat/ui?…`),
 *      not `…/ui/` — a trailing slash would add a path segment and make
 *      `./tool-call` resolve to `…/ui/tool-call`, which routes nowhere.
 *   2. The blob document's origin is opaque (Claude's widget context is a
 *      sandboxed frame; the blob inherits that) — every daemon request it
 *      makes carries `Origin: null`, which the daemon's browser gates
 *      (`guardBrowserOrigin`, `authorizeMcp`, `checkSessionsToken`) refuse
 *      unless the request ALSO carries the embed token. The chat UI talks to
 *      the daemon with absolute urls (`${DAEMON_URL}/mcp`, `/sessions/*`,
 *      its SSE stream via `fetch`, `/sessions/:id/chat`) that we don't
 *      control, so a small shim is injected ahead of every app script: it
 *      wraps `window.fetch` / `window.EventSource` to append `et=` to any
 *      request aimed at the daemon origin, and points
 *      `window.__AGENTPROTO_BASEURL__` at the daemon origin the deep link
 *      names (so a non-default port works too).
 *   3. The standalone bridge's `fetch("./tool-call"` (runtime
 *      app-ui-apps.ts `STANDALONE_REST_BRIDGE_SCRIPT`) is additionally
 *      rewritten to the absolute tokened url — belt and braces on top of
 *      the shim, and the one rewrite that is exact-string-testable.
 *   4. The shim's FIRST statement posts `{ type: "agentproto-blob-boot" }`
 *      to its parent. A blob document inherits its creator's CSP, so if the
 *      host's widget CSP ever kills inline scripts, that ack never arrives
 *      and the panel tears the blob down and falls back to the direct frame
 *      + launcher card (panel.ts `armBlobBootProbe`) instead of leaving a
 *      silent blank. No CSP `<meta>` is added to the blob html: the
 *      creator's CSP wins regardless, it would only be noise.
 *
 * Shipped as a JS string (same shape as ../panel-bridge.ts) so the panel
 * page embeds the exact code the test evaluates — no TS twin to drift from.
 */

/** `postMessage` type the injected shim sends its parent on boot. */
export const BLOB_BOOT_MESSAGE_TYPE = "agentproto-blob-boot"

export function blobEmbedScript(): string {
  return `// ── Blob pass-through transform (shared: session-chat/blob-embed.ts) ──
function _blobEscapeAttr(s){ return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
// Rewrite the fetched chat html so it works as a blob: document: <base> on
// the deep link, a fetch/EventSource shim that carries the embed token to
// the daemon origin, and the standalone bridge's ./tool-call made absolute.
function transformChatHtmlForBlob(html, url, token){
  var origin = new URL(url).origin;
  var tc = new URL('./tool-call', url);
  tc.searchParams.set('et', token);
  var shim = '<script>(function(){'
    + 'try { window.parent.postMessage({ type: ${JSON.stringify(BLOB_BOOT_MESSAGE_TYPE)} }, "*"); } catch (_) {}'
    + 'var ORIGIN = ' + JSON.stringify(origin) + ', TOKEN = ' + JSON.stringify(token) + ';'
    + 'window.__AGENTPROTO_BASEURL__ = ORIGIN;'
    + 'function withEt(u){'
    +   'try {'
    +     'var x = new URL(String(u), document.baseURI);'
    +     'if (x.origin !== ORIGIN) return null;'
    +     'if (!x.searchParams.has("et")) x.searchParams.set("et", TOKEN);'
    +     'return x.href;'
    +   '} catch (_) { return null; }'
    + '}'
    + 'var _fetch = window.fetch;'
    + 'if (typeof _fetch === "function") {'
    +   'window.fetch = function(input, init){'
    +     'var r;'
    +     'if (typeof Request !== "undefined" && input instanceof Request) {'
    +       'r = withEt(input.url);'
    +       'if (r) { try { input = new Request(r, input); } catch (_) {} }'
    +     '} else {'
    +       'r = withEt(input);'
    +       'if (r) input = r;'
    +     '}'
    +     'return _fetch.call(window, input, init);'
    +   '};'
    + '}'
    + 'var _ES = window.EventSource;'
    + 'if (typeof _ES === "function") {'
    +   'window.EventSource = function(u, cfg){ return new _ES(withEt(u) || u, cfg); };'
    +   'window.EventSource.prototype = _ES.prototype;'
    + '}'
    + '})();<\\/script>';
  var head = '<base href="' + _blobEscapeAttr(url) + '">' + shim;
  var m = html.match(/<head[^>]*>/i);
  var out = m
    ? html.slice(0, m.index + m[0].length) + head + html.slice(m.index + m[0].length)
    : head + html;
  return out.split('fetch("./tool-call"').join('fetch(' + JSON.stringify(tc.href));
}`
}
