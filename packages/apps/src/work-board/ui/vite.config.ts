import { defineConfig, type Plugin } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"
import { panelBridgeScript } from "../../panel-bridge.js"

const PANEL_BRIDGE_PLACEHOLDER = "<!--PANEL_BRIDGE-->"

/**
 * Injects the shared MCP-Apps postMessage bridge (panel-bridge.ts) as a
 * literal inline `<script>` — a classic script, not a module, so its
 * `initBridge`/`callTool` globals exist before main.ts's deferred module
 * script runs (see index.html's comment on load order). Runs during Vite's
 * own `transformIndexHtml` pass, ahead of vite-plugin-singlefile's later
 * asset-inlining pass — by the time singlefile touches the document this is
 * already a plain inline `<script>` with no `src`, which singlefile leaves
 * untouched (it only rewrites `<script src>` / `<link href>`).
 */
function injectPanelBridge(): Plugin {
  return {
    name: "work-board-inject-panel-bridge",
    transformIndexHtml(html) {
      if (!html.includes(PANEL_BRIDGE_PLACEHOLDER)) {
        throw new Error("work-board ui/index.html is missing the <!--PANEL_BRIDGE--> placeholder")
      }
      return html.replace(
        PANEL_BRIDGE_PLACEHOLDER,
        `<script>${panelBridgeScript("agentproto-work-board-panel")}</script>`,
      )
    },
  }
}

// Single-file output: the same artefact must be valid as an MCP-Apps host
// resource, a VS Code `srcdoc` iframe, and a standalone HTTP page — no
// external asset fetches are possible in any of the three. `format: "iife"`
// (rather than Vite's default ESM entry) drops the `type="module"`
// attribute from the emitted script — irrelevant for a fully inlined,
// import-free bundle — and is what makes the artefact runnable by hosts
// that only execute classic scripts (jsdom, used by this package's own
// render smoke test, is one: it deliberately does not implement
// `type="module"` script execution).
export default defineConfig({
  plugins: [injectPanelBridge(), viteSingleFile()],
  build: {
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000_000,
    modulePreload: false,
    // Unminified: this bundle is served once, locally, as a small (~20KB)
    // embedded panel — not fetched repeatedly over a network — so there's
    // no real size pressure, and keeping recognizable source (e.g. the
    // literal `full: true` in the task_list call) means it's readable
    // straight from a host's devtools AND matches
    // __tests__/work-board.test.ts's literal-text regression guards without
    // those tests needing to know anything about how this bundle is built.
    minify: false,
    rollupOptions: {
      output: {
        format: "iife",
      },
    },
  },
})
