/**
 * Ambient globals the shared panel bridge (panel-bridge.ts) defines in the
 * rendered page — the UI sources import nothing from it (it's inlined as a
 * classic <script> ahead of this bundle), so the shapes are declared here.
 * Mirrors work-board/ui/bridge.d.ts.
 */

type BridgeHostContext = {
  displayMode?: string
  availableDisplayModes?: string[]
}

type BridgeRawResult = {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
}

declare function initBridge(): Promise<void>
declare function callTool<TArgs, TResult>(name: string, args?: TArgs): Promise<TResult>
declare function getHostContext(): BridgeHostContext | null
declare function onHostContext(cb: (ctx: BridgeHostContext) => void): void
declare function requestDisplayMode(mode: string): Promise<BridgeRawResult>
