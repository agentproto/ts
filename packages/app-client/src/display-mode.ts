/**
 * `@agentproto/app-client/display-mode` — the ONE display-mode ("⤢ Agrandir")
 * toggle every agentproto app UI gets, injected as a `<script>` the same way
 * `runner-select.ts` injects `window.AgentprotoUI.mountRunnerSelect`.
 *
 * It replaces two hand-rolled copies that had drifted apart:
 *   - `packages/apps/src/panel-bridge.ts` — the `#dm`/`#pin` buttons every
 *     built-in panel (sessions, work-board, session-story, …) embedded.
 *   - `packages/runtime/src/app-ui-apps.ts` — the `window.McpApp` bridge
 *     injected into every INSTALLED app's `ui.path` html, which had no
 *     toggle at all, so an installed app could never leave `inline`.
 * Both now call `window.AgentprotoUI.installDisplayMode(api, opts)` with
 * their own JSON-RPC plumbing and get the same button, placement and theming.
 *
 * What the copies got wrong, and what this one does instead:
 *
 * - **Placement.** Both pinned `top:8px; right:8px`, which in Codex (OpenAI)
 *   puts the button partly UNDER the host's own header chrome. The MCP-Apps
 *   spec already says where that chrome is: `hostContext.safeAreaInsets`
 *   (`{top,right,bottom,left}` in px — ext-apps `McpUiHostContext`, spec
 *   `2026-01-26`). The insets are re-read on every
 *   `ui/notifications/host-context-changed` and published as
 *   `--agentproto-dm-safe-top` / `--agentproto-dm-safe-right` on
 *   `document.documentElement`, which the stylesheet consumes UNDER the
 *   app-overridable `--agentproto-dm-top` / `--agentproto-dm-right` — so an
 *   app that sets its own offsets still wins, and one that doesn't tracks
 *   the host.
 * - **Theme.** Both hard-coded white/grey with a `prefers-color-scheme` dark
 *   block, ignoring `hostContext.theme` — a host in dark mode inside a light
 *   OS got a white button. Here `theme` (when the host sends one) wins via a
 *   `data-theme` attribute, and `prefers-color-scheme` is the fallback for
 *   hosts that send none. Every colour resolves through
 *   `--agentproto-dm-bg` / `-fg` / `-border`, so an app can restyle the
 *   button without knowing this file exists.
 * - **Hosts that advertise nothing.** Claude Desktop doesn't list
 *   `fullscreen` in `availableDisplayModes` and ships its own native
 *   fullscreen control on the widget frame, so the default stays what it
 *   was: hidden unless the host advertises the mode. `optimistic` is the
 *   opt-in for hosts that honour `ui/request-display-mode` without
 *   advertising it — the button shows, and the FIRST refusal (a rejected
 *   request, or a result that settles on a different mode) hides it
 *   permanently, so a host that really can't do it costs the user exactly
 *   one dead click.
 * - **App-controlled placement.** An app with its own header doesn't want a
 *   floating button over its chrome. `controller.mountToggle(el)` renders
 *   the same button inline wherever the app says, and
 *   `<meta name="agentproto-display-toggle" content="none">` (or
 *   `connect({ displayToggle: "none" })` on the installed-app path) turns
 *   the floating one off.
 *
 * The emitted script is plain ES5 — no build step, it runs as-is in the
 * app's iframe/tab — and is idempotent: a document that already defines
 * `window.AgentprotoUI.installDisplayMode` is left alone, and only the first
 * installer in a document mounts the floating bar (a built-in panel served
 * standalone gets BOTH this bridge's copy and its own).
 */

/** Display modes the MCP-Apps ext spec defines (`McpUiDisplayMode`). */
export type DisplayMode = "inline" | "fullscreen" | "pip"

/** The slice of `McpUiHostContext` (ext-apps spec `2026-01-26`) the toggle
 *  reads. Hosts send partial updates, so every field is optional. */
export interface DisplayModeHostContext {
  displayMode?: DisplayMode
  availableDisplayModes?: DisplayMode[]
  /** `"light" | "dark"` (`McpUiTheme`). Absent ⇒ `prefers-color-scheme`. */
  theme?: string
  /** Host chrome to stay clear of, in px (`McpUiHostContext.safeAreaInsets`). */
  safeAreaInsets?: { top?: number; right?: number; bottom?: number; left?: number }
}

/** The bridge plumbing `installDisplayMode` needs from its caller — the
 *  three calls both the panel bridge and the `window.McpApp` bridge already
 *  had, so neither has to grow a new transport for the toggle. */
export interface DisplayModeBridge {
  /** Last host context seen, or `null` before `ui/initialize` resolves. */
  getHostContext?(): DisplayModeHostContext | null
  /** Subscribe to host-context changes. Implementations replay the current
   *  context immediately so a late subscriber isn't stuck blind. */
  onHostContext?(cb: (ctx: DisplayModeHostContext) => void): void
  /** JSON-RPC `ui/request-display-mode`; resolves with
   *  `McpUiRequestDisplayModeResult` (`{ mode }` — the mode actually set,
   *  which the spec allows to differ from the one requested). */
  requestDisplayMode?(mode: DisplayMode): Promise<{ mode?: DisplayMode } | undefined>
}

export interface DisplayModeOptions {
  /** Overrides the `<meta name="agentproto-display-toggle">` value.
   *  - `"auto"` (default) — floating button, shown only for the modes the
   *    host advertises.
   *  - `"none"` — no floating button; the app mounts its own via
   *    `mountToggle(el)`, or relies on the host's native control.
   *  - `"optimistic"` — floating button even when the host advertises
   *    nothing, hidden permanently on the first refusal. */
  toggle?: "auto" | "none" | "optimistic"
}

export interface DisplayModeController {
  /** The current display mode (`"inline"` until the host says otherwise). */
  get(): DisplayMode
  /** The modes the host advertises, as a copy (`[]` when it advertises
   *  none — which is also what a standalone tab reports). */
  available(): DisplayMode[]
  /** Ask the host for `mode`; resolves with the mode actually set. In
   *  `optimistic` mode a refusal also retires the button for good. */
  request(mode: DisplayMode): Promise<DisplayMode>
  /** Called with `(mode, hostContext)` on every change, and once
   *  immediately with the current value. Returns an unsubscribe. */
  onChange(cb: (mode: DisplayMode, ctx: DisplayModeHostContext) => void): () => void
  /** Render a toggle button. With `el`, it is appended there inline (an app
   *  putting the control in its own header); without, into the floating
   *  top-right bar. `mode` defaults to `"fullscreen"`. The button hides
   *  itself whenever the host doesn't offer that mode — remove it from the
   *  DOM to drop it for good. */
  mountToggle(el?: HTMLElement | null, mode?: DisplayMode): HTMLButtonElement
}

declare global {
  interface AgentprotoUIGlobal {
    installDisplayMode(
      api: DisplayModeBridge,
      opts?: DisplayModeOptions,
    ): DisplayModeController
  }
  interface Window {
    AgentprotoUI?: AgentprotoUIGlobal
  }
}

/** The `<meta name>` an app sets to opt out of (or into) the floating
 *  button: `content="none" | "auto" | "optimistic"`. */
export const DISPLAY_TOGGLE_META_NAME = "agentproto-display-toggle"

/** The dark palette, interpolated into BOTH the `[data-theme="dark"]` rule
 *  and the `prefers-color-scheme` fallback so the two can't drift. Every
 *  value still reads the app-overridable custom property first. */
const DARK_PALETTE_CSS =
  "border-color:var(--agentproto-dm-border,#555);" +
  "background:var(--agentproto-dm-bg,#2a2a2a);" +
  "color:var(--agentproto-dm-fg,#f0f0f0);" +
  "box-shadow:0 1px 4px rgba(0,0,0,.5)"

/**
 * The installer, as raw ES5 with no `<script>` wrapper — for a caller that
 * inlines it into an existing script block (`panelBridgeScript`, whose
 * `getHostContext`/`onHostContext`/`requestDisplayMode` live in panel scope).
 * Wrapped in its own IIFE so nothing leaks into that scope.
 *
 * Use {@link DISPLAY_MODE_SCRIPT} instead when injecting into html.
 */
export const DISPLAY_MODE_SCRIPT_BODY = `(function () {
  if (window.AgentprotoUI && window.AgentprotoUI.installDisplayMode) return;
  window.AgentprotoUI = window.AgentprotoUI || {};

  var STYLE_ID = "agentproto-display-mode-style";
  var BAR_ID = "agentproto-display-mode-bar";
  // Gap between the host's safe area (or the viewport edge) and the button.
  var EDGE_GAP = 8;

  // Glyph + accessible label per mode. The button is an icon; the words go
  // to title/aria-label so the control stays compact without going mute to
  // a screen reader.
  var LABELS = {
    fullscreen: {
      on: "\\u2921", off: "\\u2922",
      onLabel: "R\\u00e9duire", offLabel: "Agrandir"
    },
    pip: {
      on: "\\u2921", off: "\\uD83D\\uDCCC",
      onLabel: "D\\u00e9tacher", offLabel: "\\u00c9pingler sur le c\\u00f4t\\u00e9 (pip)"
    }
  };

  // Every colour and both offsets resolve through an app-overridable custom
  // property first, so an app can restyle/reposition the button with a
  // stylesheet and never touch this script. The safe-area vars are what the
  // host's own chrome feeds (see applyInsets), sitting UNDER the app's.
  function ensureStyle() {
    if (!document.head || document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "#" + BAR_ID + "{position:fixed;display:flex;gap:6px;align-items:center;z-index:10;" +
      "top:var(--agentproto-dm-top,var(--agentproto-dm-safe-top,8px));" +
      "right:var(--agentproto-dm-right,var(--agentproto-dm-safe-right,8px))}" +
      ".agentproto-dm-btn{display:inline-flex;align-items:center;justify-content:center;" +
      "box-sizing:border-box;width:28px;height:28px;padding:0;margin:0;border-radius:6px;" +
      "cursor:pointer;-webkit-appearance:none;appearance:none;" +
      "font:600 14px/1 system-ui,-apple-system,sans-serif;" +
      "border:1px solid var(--agentproto-dm-border,#d0d0d0);" +
      "background:var(--agentproto-dm-bg,#fff);" +
      "color:var(--agentproto-dm-fg,#1a1a1a);" +
      "box-shadow:0 1px 4px rgba(0,0,0,.18)}" +
      ".agentproto-dm-btn:hover{filter:brightness(.95)}" +
      ".agentproto-dm-btn:focus-visible{outline:2px solid var(--agentproto-dm-fg,#1a1a1a);outline-offset:2px}" +
      ".agentproto-dm-btn[data-theme=\\"dark\\"]{${DARK_PALETTE_CSS}}" +
      "@media (prefers-color-scheme:dark){" +
      ".agentproto-dm-btn:not([data-theme=\\"light\\"]){${DARK_PALETTE_CSS}}}";
    document.head.appendChild(style);
  }

  function ready(fn) {
    if (document.body) fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  function metaToggle() {
    var el = document.querySelector('meta[name="${DISPLAY_TOGGLE_META_NAME}"]');
    if (!el) return "";
    return (el.getAttribute("content") || "").toLowerCase().replace(/^\\s+|\\s+$/g, "");
  }

  function ensureBar() {
    var bar = document.getElementById(BAR_ID);
    if (bar) return bar;
    bar = document.createElement("div");
    bar.id = BAR_ID;
    document.body.appendChild(bar);
    return bar;
  }

  function px(v) {
    return typeof v === "number" && isFinite(v) && v > 0 ? v : 0;
  }

  window.AgentprotoUI.installDisplayMode = function (api, opts) {
    api = api || {};
    opts = opts || {};

    var ctx = {};
    var listeners = [];
    var buttons = [];
    // Modes the host has refused once. Checked before availability, so a
    // later host-context-changed can never resurrect a dead button.
    var refused = {};
    var loggedKeys = false;

    var setting = opts.toggle || metaToggle() || "auto";
    var optimistic = setting === "optimistic";
    var autoMount = setting !== "none";

    function get() {
      return ctx.displayMode || "inline";
    }

    function available() {
      var a = ctx.availableDisplayModes;
      return a && a.slice ? a.slice() : [];
    }

    function supports(mode) {
      if (refused[mode]) return false;
      var a = ctx.availableDisplayModes;
      if (a && a.indexOf && a.indexOf(mode) >= 0) return true;
      // Optimistic: the host advertises nothing (Claude Desktop, some
      // embedders) but may still honour the request. Fullscreen only — pip
      // is niche enough that guessing at it is just noise.
      return optimistic && mode === "fullscreen";
    }

    // Host chrome to stay clear of. Published as custom properties rather
    // than inline styles so an app's own --agentproto-dm-top/right still
    // wins (an inline style would beat any stylesheet it could write).
    function applyInsets() {
      var insets = ctx.safeAreaInsets || {};
      var root = document.documentElement;
      if (!root || !root.style || !root.style.setProperty) return;
      root.style.setProperty("--agentproto-dm-safe-top", (px(insets.top) + EDGE_GAP) + "px");
      root.style.setProperty("--agentproto-dm-safe-right", (px(insets.right) + EDGE_GAP) + "px");
    }

    function syncButton(btn) {
      var mode = btn.getAttribute("data-agentproto-dm") || "fullscreen";
      var labels = LABELS[mode] || LABELS.fullscreen;
      var active = get() === mode;
      btn.style.display = supports(mode) ? "" : "none";
      btn.textContent = active ? labels.on : labels.off;
      var label = active ? labels.onLabel : labels.offLabel;
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
      if (ctx.theme === "dark" || ctx.theme === "light") btn.setAttribute("data-theme", ctx.theme);
      else btn.removeAttribute("data-theme");
    }

    function sync() {
      applyInsets();
      for (var i = buttons.length - 1; i >= 0; i--) {
        // An app that removed its inline toggle stops being our problem.
        if (buttons[i].isConnected === false) { buttons.splice(i, 1); continue; }
        syncButton(buttons[i]);
      }
    }

    function emit() {
      var mode = get();
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](mode, ctx); } catch (_) {}
      }
    }

    // host-context-changed carries only the changed keys — merge, matching
    // the official ext-apps App behaviour.
    function setContext(next) {
      if (!next || typeof next !== "object") return;
      for (var k in next) {
        if (Object.prototype.hasOwnProperty.call(next, k)) ctx[k] = next[k];
      }
      sync();
      emit();
    }

    function retire(mode) {
      refused[mode] = true;
      sync();
    }

    function request(mode) {
      var pending;
      try {
        pending = api.requestDisplayMode
          ? api.requestDisplayMode(mode)
          : Promise.reject(new Error("display mode: no host"));
      } catch (err) {
        pending = Promise.reject(err);
      }
      return Promise.resolve(pending).then(function (result) {
        // McpUiRequestDisplayModeResult.mode is the mode actually set, and
        // the spec lets it differ from the one asked for — so a host that
        // answers "still inline" is a refusal, not a success.
        var settled = (result && result.mode) || mode;
        if (optimistic && mode !== "inline" && settled !== mode) {
          retire(mode);
          throw new Error("host refused display mode: " + mode);
        }
        // Hosts are not required to follow up with host-context-changed —
        // trust the result so the glyph flips either way.
        setContext({ displayMode: settled });
        return settled;
      }, function (err) {
        if (optimistic && mode !== "inline") retire(mode);
        throw err;
      });
    }

    function makeButton(mode) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "agentproto-dm-btn";
      // Stable id for the floating pair (styling hooks, tests). An app that
      // mounts extra inline toggles gets unnamed ones rather than duplicates.
      var id = mode === "fullscreen"
        ? "agentproto-display-mode"
        : "agentproto-display-mode-" + mode;
      if (!document.getElementById(id)) btn.id = id;
      btn.setAttribute("data-agentproto-dm", mode);
      btn.style.display = "none";
      btn.addEventListener("click", function () {
        var cur = get();
        // Same rule both copies had: anything that isn't inline collapses
        // back to inline, so the button is always an escape hatch.
        var inPanel = cur === "fullscreen" || cur === "pip";
        request(inPanel ? "inline" : mode)["catch"](function () {});
      });
      return btn;
    }

    function mountToggle(el, mode) {
      ensureStyle();
      mode = mode || "fullscreen";
      var btn = makeButton(mode);
      if (el) el.appendChild(btn);
      else ensureBar().appendChild(btn);
      buttons.push(btn);
      syncButton(btn);
      return btn;
    }

    function onChange(cb) {
      if (typeof cb !== "function") return function () {};
      listeners.push(cb);
      try { cb(get(), ctx); } catch (_) {}
      return function () {
        var i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    }

    ready(function () {
      ensureStyle();
      // Only the first installer in a document owns the floating bar: a
      // built-in panel served standalone gets the injected window.McpApp
      // bridge's copy AND its own, and two stacked buttons is a bug.
      if (autoMount && !document.getElementById(BAR_ID)) {
        ensureBar();
        mountToggle(null, "pip");
        mountToggle(null, "fullscreen");
      }
      sync();
    });

    // The diagnostic both copies had, now on BOTH paths: it used to exist
    // only in the built-in panel bridge, so an installed app debugged in
    // Claude Desktop (which advertises no fullscreen, hence no button)
    // printed nothing at all and left the user with no way to tell "the
    // host refuses" from "the toggle is broken".
    function observe(next) {
      console.log('[mcp-app] displayMode=', next && next.displayMode,
                  'availableDisplayModes=', next && next.availableDisplayModes);
      setContext(next);
      // What ELSE does this host send? Keys only, once — a host context can
      // carry toolInfo (the instantiating tool call's arguments) and other
      // host-private fields, so the names are the diagnostic and the values
      // stay out of the console.
      if (!loggedKeys && next && typeof next === "object") {
        loggedKeys = true;
        var keys = [];
        for (var k in ctx) {
          if (Object.prototype.hasOwnProperty.call(ctx, k)) keys.push(k);
        }
        console.log('[mcp-app] hostContext keys=', keys.sort().join(','));
      }
    }

    if (typeof api.onHostContext === "function") api.onHostContext(observe);
    else if (typeof api.getHostContext === "function") observe(api.getHostContext());

    return {
      get: get,
      available: available,
      request: request,
      onChange: onChange,
      mountToggle: mountToggle
    };
  };
})();`

/** {@link DISPLAY_MODE_SCRIPT_BODY} wrapped in a `<script>` tag, for callers
 *  that inject into html (`injectMcpAppBridge` /
 *  `injectStandaloneAppBridge`, `packages/runtime/src/app-ui-apps.ts`). */
export const DISPLAY_MODE_SCRIPT = `<script>
${DISPLAY_MODE_SCRIPT_BODY}
</script>
`
