/**
 * Ambient globals defined by the classic (non-module) `<script>` that
 * vite.config.ts's `injectPanelBridge` plugin inlines from
 * `panelBridgeScript()` (../../panel-bridge.ts) ahead of this module script
 * — see that file's docblock for the wire protocol. Only the two calls
 * main.ts actually makes are declared; the rest of the bridge's surface
 * (getHostContext/onHostContext/requestDisplayMode/onHostNotification) is
 * consumed entirely inside the injected script itself (the display-mode
 * toggle buttons), so the board's own code never needs it typed here.
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
}
