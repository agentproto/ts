/**
 * `@agentproto/app-client/runner-select` — a framework-free harness+model
 * picker for app UIs, injected as a `<script>` tag the same way
 * `injectMcpAppBridge` injects `window.McpApp` (see
 * `packages/runtime/src/app-ui-apps.ts`). Every installed app UI hand-rolled
 * (or omitted) its own picker with no way to discover what the host
 * actually has installed; this module is the one shared implementation,
 * mounted via `window.AgentprotoUI.mountRunnerSelect(container, opts)`.
 *
 * The exported `RUNNER_SELECT_SCRIPT` is plain ES5 (no build step, runs
 * directly in the app's iframe/tab) — it discovers the host's installed
 * harnesses/models via `adapter_list` + `harness_preset_list` (the app's
 * OWN `callTool`, typically routed through `app_tool_call`), restores/
 * persists the caller's choice in `localStorage`, and hands back a small
 * imperative handle. It never resolves `access`/`profileRef` — the
 * daemon's default harness preset (`harness-presets.json`) resolves
 * billing, same as an unpinned `agent_start`.
 */

/** The read-only, non-secret discovery tools `mountRunnerSelect` calls.
 *  Every installed app UI gets these for free regardless of its own
 *  `ui.tools` allowlist — see `performAppToolCall`'s effective allowlist
 *  (`installed.ui.tools ∪ APP_UI_DISCOVERY_TOOLS`). */
export const APP_UI_DISCOVERY_TOOLS = ["adapter_list", "harness_preset_list"] as const

/** What `getRunner()` returns — the two fields `agent_start`/`app_run`
 *  accept to pin a spawn's harness + model. `model` is omitted when the
 *  caller left it blank, so the harness's default preset model applies. */
export interface RunnerSelection {
  harness: string
  model?: string
}

export interface RunnerSelectOptions {
  /** The app's own tool-call wrapper (typically routes via
   *  `app_tool_call({appId, tool, args})`), resolving to the unwrapped
   *  JSON result — same shape `McpConnection.callTool` resolves to. */
  callTool: (tool: string, args?: object) => Promise<unknown>
  /** localStorage key the last-picked runner is persisted under. */
  storageKey?: string
  /** Initial selection when nothing is stored yet. */
  defaults?: { harness?: string; model?: string }
  /** Fires after every change (and the initial restore), with the same
   *  value `getRunner()` would return at that point. */
  onChange?: (sel: RunnerSelection) => void
  /** Single-row layout instead of the default stacked one. */
  compact?: boolean
}

export interface RunnerSelectHandle {
  getRunner(): RunnerSelection
  /** Re-run discovery (`adapter_list` + `harness_preset_list`) and
   *  re-render. Each source is independent — a rejection from one leaves
   *  that source empty with a muted note rather than rejecting the whole
   *  call. */
  refresh(): Promise<void>
  element: HTMLElement
  destroy(): void
}

declare global {
  interface Window {
    AgentprotoUI?: {
      mountRunnerSelect(container: HTMLElement, opts: RunnerSelectOptions): RunnerSelectHandle
    }
  }
}

/**
 * Plain ES5, mirroring the style of `MCP_APP_BRIDGE_SCRIPT` /
 * `STANDALONE_REST_BRIDGE_SCRIPT` (`app-ui-apps.ts`) — a `<script>` block an
 * app's served HTML can inline directly, no bundler involved. Guards on
 * `window.AgentprotoUI.mountRunnerSelect` already existing so a page that
 * got the bridge injected twice (or ships its own copy) is a no-op.
 */
export const RUNNER_SELECT_SCRIPT = `<script>
(function () {
  if (window.AgentprotoUI && window.AgentprotoUI.mountRunnerSelect) return;
  window.AgentprotoUI = window.AgentprotoUI || {};

  var STYLE_ID = "agentproto-runner-select-style";
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      ".agentproto-runner-select { display: flex; flex-direction: column; gap: 8px;" +
      " font: 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;" +
      " color: var(--text2, #333); }" +
      ".agentproto-runner-select.compact { flex-direction: row; align-items: center; flex-wrap: wrap; }" +
      ".agentproto-runner-select label { display: flex; flex-direction: column; gap: 4px; }" +
      ".agentproto-runner-select.compact label { flex-direction: row; align-items: center; gap: 6px; }" +
      ".agentproto-runner-select select, .agentproto-runner-select input {" +
      " background: var(--bg, #fff); border: 1px solid var(--border, #ccc);" +
      " color: inherit; border-radius: 4px; padding: 4px 6px; font: inherit; }" +
      ".agentproto-runner-select .agentproto-runner-note {" +
      " color: var(--text2, #888); opacity: 0.75; font-size: 12px; }";
    document.head.appendChild(style);
  }

  window.AgentprotoUI.mountRunnerSelect = function (container, opts) {
    opts = opts || {};
    var callTool = opts.callTool;
    var storageKey = opts.storageKey || "agentproto.runner";
    var defaults = opts.defaults || {};
    var onChangeCb = opts.onChange;
    var compact = !!opts.compact;

    var stored = null;
    try {
      var raw = window.localStorage.getItem(storageKey);
      if (raw) stored = JSON.parse(raw);
    } catch (e) {}

    var state = {
      harness: (stored && stored.harness) || defaults.harness || "",
      model: (stored && stored.model) || defaults.model || ""
    };

    var presets = [];
    var adapters = [];
    var harnessNote = "";
    var adapterNote = "";

    ensureStyle();

    var root = document.createElement("div");
    root.className = "agentproto-runner-select" + (compact ? " compact" : "");

    var harnessLabel = document.createElement("label");
    harnessLabel.textContent = "Harness";
    var harnessSelect = document.createElement("select");
    harnessLabel.appendChild(harnessSelect);

    var modelLabel = document.createElement("label");
    modelLabel.textContent = "Model";
    var modelInput = document.createElement("input");
    modelInput.type = "text";
    var datalistId = "agentproto-runner-model-list-" + Math.random().toString(36).slice(2);
    modelInput.setAttribute("list", datalistId);
    var datalist = document.createElement("datalist");
    datalist.id = datalistId;
    modelLabel.appendChild(modelInput);
    modelLabel.appendChild(datalist);

    var note = document.createElement("div");
    note.className = "agentproto-runner-note";

    root.appendChild(harnessLabel);
    root.appendChild(modelLabel);
    root.appendChild(note);
    container.appendChild(root);

    function persist() {
      try { window.localStorage.setItem(storageKey, JSON.stringify(state)); } catch (e) {}
    }

    function getRunner() {
      var sel = { harness: state.harness };
      if (state.model) sel.model = state.model;
      return sel;
    }

    function notify() {
      persist();
      if (onChangeCb) onChangeCb(getRunner());
    }

    function findDefaultPresetFor(slug) {
      for (var i = 0; i < presets.length; i++) {
        if (presets[i].harnessSlug === slug && presets[i].isDefault) return presets[i];
      }
      return null;
    }

    function findAdapter(slug) {
      for (var i = 0; i < adapters.length; i++) {
        if (adapters[i].slug === slug) return adapters[i];
      }
      return null;
    }

    function renderHarnessOptions() {
      harnessSelect.innerHTML = "";
      var seen = {};
      for (var i = 0; i < adapters.length; i++) {
        var a = adapters[i];
        seen[a.slug] = true;
        var opt = document.createElement("option");
        opt.value = a.slug;
        var label = a.name || a.slug;
        var preset = findDefaultPresetFor(a.slug);
        if (preset) {
          label += " — " + preset.name;
          if (preset.profileDisabled) label += " (profile disabled)";
        }
        opt.textContent = label;
        harnessSelect.appendChild(opt);
      }
      // The restored/default harness is always present as an option, even
      // when discovery returned nothing for it (still loading, or a
      // rejected adapter_list) — never silently drop the caller's choice.
      if (state.harness && !seen[state.harness]) {
        var fallback = document.createElement("option");
        fallback.value = state.harness;
        fallback.textContent = state.harness;
        harnessSelect.appendChild(fallback);
      }
      if (!state.harness && adapters.length > 0) {
        state.harness = adapters[0].slug;
      }
      harnessSelect.value = state.harness;
    }

    function renderModelDatalist() {
      datalist.innerHTML = "";
      var adapter = findAdapter(state.harness);
      var models = (adapter && adapter.models) || [];
      for (var i = 0; i < models.length; i++) {
        var opt = document.createElement("option");
        opt.value = models[i];
        datalist.appendChild(opt);
      }
      var preset = findDefaultPresetFor(state.harness);
      modelInput.placeholder = (preset && preset.defaultModel) || "adapter default";
      modelInput.value = state.model || "";
    }

    function renderNote() {
      var parts = [];
      if (harnessNote) parts.push(harnessNote);
      if (adapterNote) parts.push(adapterNote);
      note.textContent = parts.join(" ");
      note.style.display = parts.length ? "" : "none";
    }

    function render() {
      renderHarnessOptions();
      renderModelDatalist();
      renderNote();
    }

    harnessSelect.addEventListener("change", function () {
      state.harness = harnessSelect.value;
      renderModelDatalist();
      notify();
    });

    modelInput.addEventListener("input", function () {
      state.model = modelInput.value;
      notify();
    });

    function safeCallTool(name, args) {
      var result;
      try {
        result = callTool(name, args);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.resolve(result);
    }

    function errMessage(err) {
      return (err && err.message) || String(err);
    }

    function refresh() {
      var harnessPromise = safeCallTool("harness_preset_list").then(
        function (r) {
          presets = (r && r.presets) || [];
          harnessNote = "";
        },
        function (err) {
          presets = [];
          harnessNote = "harness list unavailable: " + errMessage(err);
        }
      );
      var adapterPromise = safeCallTool("adapter_list", { summary: true }).then(
        function (r) {
          adapters = (r && r.adapters) || [];
          adapterNote = "";
        },
        function (err) {
          adapters = [];
          adapterNote = "adapter list unavailable: " + errMessage(err);
        }
      );
      return Promise.all([harnessPromise, adapterPromise]).then(function () {
        render();
        notify();
      });
    }

    render();
    refresh();

    return {
      getRunner: getRunner,
      refresh: refresh,
      element: root,
      destroy: function () {
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  };
})();
</script>
`

/** Insert `script` right after the earliest structural opening tag the
 *  document has (`<head>`, else `<body>`, else `<html>`, else prepend) —
 *  same placement rule as `injectMcpAppBridge` (`app-ui-apps.ts`). Kept as
 *  a private copy here rather than a shared import: this package is
 *  framework-free with zero deps and must not pull in `@agentproto/runtime`. */
function injectAfterStructuralTag(html: string, script: string): string {
  for (const tag of ["head", "body", "html"]) {
    const match = html.match(new RegExp(`<${tag}[^>]*>`, "i"))
    if (match?.index !== undefined) {
      const insertAt = match.index + match[0].length
      return html.slice(0, insertAt) + script + html.slice(insertAt)
    }
  }
  return script + html
}

/** Inject `RUNNER_SELECT_SCRIPT` (see `injectAfterStructuralTag` for the
 *  placement rule). Idempotent: a no-op when the document already DEFINES
 *  `window.AgentprotoUI` (an earlier injection pass, or an app shipping its
 *  own copy). */
export function injectRunnerSelect(html: string): string {
  if (/window\.AgentprotoUI\s*=/.test(html)) return html
  return injectAfterStructuralTag(html, RUNNER_SELECT_SCRIPT)
}
