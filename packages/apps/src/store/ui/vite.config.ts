import { defineConfig, type Plugin } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"
import { panelBridgeScript } from "../../panel-bridge.js"

const PANEL_BRIDGE_PLACEHOLDER = "<!--PANEL_BRIDGE-->"

/**
 * Injects the shared MCP-Apps postMessage bridge (panel-bridge.ts) as a
 * literal inline `<script>` — the same mechanism work-board's
 * ui/vite.config.ts uses (see that plugin's doc for why it must be a
 * classic script). The placeholder contract is identical; only the plugin
 * name differs so a build log names the panel actually being built.
 */
function injectPanelBridge(): Plugin {
  return {
    name: "store-inject-panel-bridge",
    transformIndexHtml(html) {
      if (!html.includes(PANEL_BRIDGE_PLACEHOLDER)) {
        throw new Error("store ui/index.html is missing the <!--PANEL_BRIDGE--> placeholder")
      }
      return html.replace(
        PANEL_BRIDGE_PLACEHOLDER,
        `<script>${panelBridgeScript("agentproto-store-panel")}</script>`,
      )
    },
  }
}

// Single-file output: the same artefact must be valid as an MCP-Apps host
// resource, a VS Code `srcdoc` iframe, and a standalone HTTP page — no
// external asset fetches are possible in any of the three. `format: "iife"`
// drops the `type="module"` attribute from the emitted script — irrelevant
// for a fully inlined, import-free bundle — and is what makes the artefact
// runnable by hosts that only execute classic scripts (jsdom, used by this
// package's own render smoke test, is one: it deliberately does not
// implement `type="module"` script execution).
export default defineConfig({
  plugins: [injectPanelBridge(), viteSingleFile()],
  build: {
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000_000,
    modulePreload: false,
    // Unminified for the same reason work-board's is: this bundle is served
    // once, locally, as a small embedded panel — not fetched repeatedly over
    // a network — so keeping recognizable source (e.g. the literal
    // `needsConfirmation` and `confirm:` names in the app_install handshake)
    // means it's readable straight from a host's devtools AND matches this
    // panel's literal-text regression guards without those tests needing to
    // know anything about how this bundle is built.
    minify: false,
    rollupOptions: {
      output: {
        format: "iife",
      },
    },
  },
})
