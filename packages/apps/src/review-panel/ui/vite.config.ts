import { defineConfig, type Plugin } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"
import { panelBridgeScript } from "../../panel-bridge.js"

const PANEL_BRIDGE_PLACEHOLDER = "<!--PANEL_BRIDGE-->"

/**
 * Injects the shared MCP-Apps postMessage bridge (panel-bridge.ts) as a
 * literal inline `<script>` — same technique as work-board/ui/vite.config.ts
 * (see that file's docblock for why it must be a classic, not module,
 * script, and why it's safe against vite-plugin-singlefile's later pass).
 */
function injectPanelBridge(): Plugin {
  return {
    name: "review-panel-inject-panel-bridge",
    transformIndexHtml(html) {
      if (!html.includes(PANEL_BRIDGE_PLACEHOLDER)) {
        throw new Error("review-panel ui/index.html is missing the <!--PANEL_BRIDGE--> placeholder")
      }
      return html.replace(
        PANEL_BRIDGE_PLACEHOLDER,
        `<script>${panelBridgeScript("agentproto-review-panel")}</script>`,
      )
    },
  }
}

// Single-file output — same rationale as work-board/ui/vite.config.ts:
// the artefact must run unmodified as an MCP-Apps host resource, a VS Code
// `srcdoc` iframe, and a standalone HTTP page, with `format: "iife"` so
// jsdom (this package's own render smoke tests) executes it as a classic
// script.
export default defineConfig({
  plugins: [injectPanelBridge(), viteSingleFile()],
  build: {
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000_000,
    modulePreload: false,
    minify: false,
    rollupOptions: {
      output: {
        format: "iife",
      },
    },
  },
})
