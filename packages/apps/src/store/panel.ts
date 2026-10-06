/**
 * HTML bundle for the agentproto App Store panel — the `STORE_HTML`
 * served as the `ui://agentproto_store/view` resource by `registerMcpApps`
 * (see ../mcp-app-types.ts and runtime's mcp-apps-adapter.ts). Mounted via
 * the `agentproto_store` tool defined in ./index.ts.
 *
 * The store over the daemon's app-catalog/install plane (packages/
 * runtime/src/app-tools.ts): Installed (version/source/Update-available
 * badge, resync + uninstall actions), Featured + Available (grouped by
 * category, tier/placement/requires chips), Install-from-URL (with the
 * `.agentapp`-vs-git detection), Sources (warnings + stale flags),
 * Builtin panels (collapsed) — and a never-blank empty state pointing at
 * how to add a catalog source.
 *
 * `STORE_HTML` is a real single-file Vite build, not a hand-authored
 * template string: the source lives in ./ui/** (index.html/main.ts/
 * types.ts/render.ts/style.css, bundled by ./ui/vite.config.ts with
 * vite-plugin-singlefile) and is committed, pre-built, into
 * ./panel.generated.ts by `pnpm --filter @agentproto/apps run
 * build:ui:store` (scripts/build-store-ui.mjs) — same committed-generated
 * contract as work-board (panel.generated.ts lives in git,
 * `build:ui:store:check` fails the CI drift gate). See ./ui/vite.config.ts
 * for how the shared `panelBridgeScript` (../panel-bridge.ts) gets inlined
 * as a classic `<script>` ahead of the bundled module script.
 *
 * Protocol: MCP Apps ext spec 2026-01-26
 *   – Bridge: JSON-RPC 2.0 over window.parent.postMessage (../panel-bridge.ts,
 *     unmodified by this change — this app only calls its `initBridge()`/
 *     `callTool()` surface).
 *   – Handshake: ui/initialize → host result → ui/notifications/initialized
 *   – Read: tools/call → app_catalog / app_list / app_updates
 *   – Apply (always through the SAME verbs every other caller uses — no
 *     second install path): app_install (CONFIRMED, two-call handshake),
 *     app_resync, app_uninstall
 */

import { STORE_HTML_GENERATED } from "./panel.generated.js"

/** The builtin's app id — how `app_catalog` reports the panel. Lives in this
 *  html-only entry (not ./index.ts) so a consumer that must NOT pull the
 *  app-kit dependency graph — the VS Code extension bundles with esbuild and
 *  chokes on its transitive native `.node` deps — can still name the panel
 *  from source. */
export const STORE_APP_ID = "@agentproto/store"

/** The MCP tool the panel is registered under (./index.ts `makeStoreApp`),
 *  hence its resource uri `ui://agentproto_store/view`. Follows the
 *  convention of every other builtin panel (`agentproto_work_board`,
 *  `agentproto_sessions`, …): `agentproto_<slug>`. */
export const STORE_TOOL_ID = "agentproto_store"

/** The daemon tools this panel's html calls, in order of use. Consumed as
 *  `ui.tools` by ./index.ts and as the client-side allowlist by any host
 *  that dispatches the panel's `tools/call` directly — a builtin is not an
 *  installed app, so `app_tool_call` cannot route for it. */
export const STORE_UI_TOOLS = [
  "app_catalog",
  "app_list",
  "app_install",
  "app_resync",
  "app_updates",
  "app_uninstall",
  "app_status",
] as const

export const STORE_HTML = STORE_HTML_GENERATED
