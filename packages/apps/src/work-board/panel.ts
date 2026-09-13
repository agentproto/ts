/**
 * HTML bundle for the agentproto work-board panel — the `WORK_BOARD_HTML`
 * served as the `ui://agentproto_work_board/view` resource by
 * `registerMcpApps` (see ../mcp-app-types.ts and runtime's
 * mcp-apps-adapter.ts). Mounted via the `agentproto_work_board` tool defined
 * in ./index.ts.
 *
 * A kanban over the daemon's Task ledger (`packages/runtime/src/
 * task-ledger.ts`) — the one writable multi-party entity the daemon exposes
 * (Activity is a read-only projection; a session has a lifecycle, not an
 * intention). Columns are the ledger's own status enum, folding `cancelled`
 * into the `failed` column (tagged distinctly — see `columnOf` in
 * ./ui/render.ts) rather than adding a fifth column for a status v1 treats
 * as terminal scrap. The board/swimlane selector is the ledger's own board
 * id (`tree:<rootSessionId>` or `ws:<slug>`) — always shown verbatim, never
 * hidden behind a friendly name, per the ledger's scoping model.
 *
 * `WORK_BOARD_HTML` is a real single-file Vite build, not a hand-authored
 * template string: the source lives in ./ui/** (index.html/main.ts/
 * types.ts/render.ts/style.css, bundled by ./ui/vite.config.ts with
 * vite-plugin-singlefile) and is committed, pre-built, into
 * ./panel.generated.ts by `pnpm --filter @agentproto/apps run build:ui`
 * (scripts/build-work-board-ui.mjs) — so this package still builds with
 * plain `pnpm build` on a fresh clone, no Vite step in the critical path.
 * `build:ui:check` (wired into CI) fails if that generated file drifts from
 * what the Vite sources actually produce. See ./ui/vite.config.ts for how
 * the shared `panelBridgeScript` (../panel-bridge.ts) gets inlined as a
 * classic `<script>` ahead of the bundled module script.
 *
 * Protocol: MCP Apps ext spec 2026-01-26
 *   – Bridge: JSON-RPC 2.0 over window.parent.postMessage (../panel-bridge.ts,
 *     unmodified by this change — this app only calls its `initBridge()`/
 *     `callTool()` surface). Standalone (no host at all, e.g. a top-level
 *     `GET /apps/:appId/ui` tab) does NOT connect yet: panel-bridge.ts's
 *     handshake has no reply to wait for in that case and hangs on
 *     "Connecting to bridge…" — a known gap being fixed in panel-bridge.ts
 *     itself by a separate change. This app will pick that fix up automatically
 *     (rebuild + rebase) once it lands; nothing here needs to special-case it.
 *   – Handshake: ui/initialize → host result → ui/notifications/initialized
 *   – Data: tools/call → task_list (`full: true` — the compact projection
 *     drops `verification`, which the verification tell needs) on a ~4 s poll
 *   – Actions: tools/call → task_claim / task_update / task_create
 *
 * Read-only-safe first: no drag-and-drop. Each card gets the explicit status
 * actions valid from its current state (Claim/Start/Done/Fail/Release/
 * Cancel/Reopen) — a correct read-only-plus-explicit-actions board beats a
 * half-wired drag, per the brief.
 *
 * The verification tell (never render an unverified done as gate-passed):
 *   - `verification.kind === "gate"`   → solid green "✓ gate"
 *   - `verification.kind === "self-report"` → amber outline "self-report"
 *   - `verification.kind === "human"`  → blue "human"
 *   - a declared `verify` with no verification yet → grey "gated" tag
 * An owner-less task always reads "Unclaimed", never "pending" (that word is
 * reserved for the Activity vocabulary's "blocked" meaning elsewhere).
 */

import { WORK_BOARD_HTML_GENERATED } from "./panel.generated.js"

/** The builtin's app id — how `app_catalog` reports the panel. Lives in this
 *  html-only entry (not ./index.ts) so a consumer that must NOT pull the
 *  app-kit dependency graph — the VS Code extension bundles with esbuild and
 *  chokes on its transitive native `.node` deps — can still name the panel
 *  from source. */
export const WORK_BOARD_APP_ID = "@agentproto/work-board"

/** The MCP tool the panel is registered under (./index.ts `makeWorkBoardApp`),
 *  hence its resource uri `ui://agentproto_work_board/view`. */
export const WORK_BOARD_TOOL_ID = "agentproto_work_board"

/** The daemon tools this panel's html calls, in order of use. Consumed as
 *  `ui.tools` by ./index.ts and as the client-side allowlist by any host that
 *  dispatches the panel's `tools/call` directly — a builtin is not an
 *  installed app, so `app_tool_call` cannot route for it. */
export const WORK_BOARD_UI_TOOLS = [
  "task_list",
  "task_claim",
  "task_update",
  "task_create",
] as const

export const WORK_BOARD_HTML = WORK_BOARD_HTML_GENERATED
