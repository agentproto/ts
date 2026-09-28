/**
 * Ambient globals defined by the classic (non-module) `<script>` that
 * vite.config.ts's `injectPanelBridge` plugin inlines from
 * `panelBridgeScript()` (../../panel-bridge.ts) ahead of this module script
 * — see that file's docblock for the wire protocol. `openLink` is declared
 * here (unlike work-board's bridge.d.ts) because this panel opens the
 * live-session widget, deep-linked to a reviewer session id — see main.ts.
 */
export {}

declare global {
  /** `ui/initialize` → `ui/notifications/initialized` handshake. Resolves
   *  once a host (or the injected standalone REST fallback) is ready. */
  function initBridge(): Promise<void>

  /** `tools/call` (embedded/relay) or `POST ./tool-call` (standalone) —
   *  either way, resolves with the tool's already-unwrapped JSON result.
   *  `TArgs` is inferred from the literal object passed at each call site,
   *  so every call stays concretely typed with no `any`/`unknown`. */
  function callTool<TArgs extends object, TResult>(name: string, args?: TArgs): Promise<TResult>

  /** `ui/open-link` (embedded) or the standalone `McpApp` connection's own
   *  `openLink` — opens an external URL through the host's own UI (a new
   *  tab, its own browser). */
  function openLink(url: string): Promise<unknown>

  /** `McpUiInitializeResult.hostCapabilities`, captured once at
   *  `initBridge()` time — `openLinks: true` says the host will actually
   *  honour `openLink`; a host without it never gets an `openLink` call. */
  function getHostCapabilities(): { openLinks?: boolean } | null
}
