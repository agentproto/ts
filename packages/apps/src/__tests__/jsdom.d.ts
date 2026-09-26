/**
 * Minimal ambient DOM + jsdom types for config-edit.test.ts.
 *
 * packages/apps's tsconfig extends node-library.json, which deliberately
 * narrows `lib` to `["ES2022"]` (no "DOM"), so lib.dom.d.ts's Window/
 * Document/HTMLInputElement aren't available here, and jsdom itself ships
 * no types. `@types/jsdom` was checked (npm registry, 2026-09-26) and does
 * not fit either: its published versions jump straight from 28.0.3 to
 * 30.0.0 — there is no 29.x release to match this repo's pinned
 * `jsdom: "^29.1.1"` (packages/apps/package.json), so installing either
 * neighbor would type-check this file against a jsdom API surface that
 * isn't the one actually running. Same conclusion, and same fix, as
 * packages/vscode/src/webview/jsdom.d.ts and
 * packages/mcp-app-host/src/__tests__/jsdom.d.ts already reached for the
 * same pinned major: hand-declare exactly the surface this one test file
 * touches, scoped inside a "jsdom" module augmentation, rather than
 * widening the whole package's ambient globals via tsconfig or pulling in
 * a types package that would silently drift from the real API.
 */
declare module "jsdom" {
  export interface DomEvent {
    readonly type: string
  }

  export interface DomClassList {
    contains(className: string): boolean
    add(className: string): void
    remove(className: string): void
  }

  export interface DomElement {
    readonly tagName: string
    className: string
    readonly classList: DomClassList
    innerHTML: string
    textContent: string | null
    value?: string
    checked?: boolean
    disabled?: boolean
    getAttribute(name: string): string | null
    dispatchEvent(event: DomEvent): boolean
    querySelector(selectors: string): DomElement | null
    querySelectorAll(selectors: string): { length: number; [index: number]: DomElement }
  }

  export interface DomBody {
    innerHTML: string
  }

  export interface DomDocument {
    readonly body: DomBody
    getElementById(id: string): DomElement | null
    querySelector(selectors: string): DomElement | null
    querySelectorAll(selectors: string): { length: number; [index: number]: DomElement }
  }

  /** The MCP-Apps standalone/postMessage bridge's resolved shape (`window.
   *  McpApp.connect()`'s result) — just enough of it for config-edit.test.ts
   *  to stand a fake in for the daemon: tool calls, updateModelContext (the
   *  secret-leak guard this suite exists to enforce), and onTeardown. */
  export interface DomMcpAppTool {
    content?: { type: string; text: string }[]
    isError?: boolean
  }

  export interface DomMcpApp {
    connect: () => Promise<{
      callTool: (name: string, args: Record<string, unknown>) => Promise<DomMcpAppTool>
      updateModelContext: (ctx: unknown) => Promise<void>
      openLink?: (url: string) => void
      onTeardown: (cb: () => void) => void
    }>
  }

  export interface DomLocation {
    hash: string
  }

  export interface DomWindow {
    readonly document: DomDocument
    location: DomLocation
    close(): void
    /** Set (or left undefined) by a test's beforeParse to stand in for the
     *  daemon-injected bridge — see {@link DomMcpApp}. */
    McpApp?: DomMcpApp
    addEventListener(type: string, handler: () => void): void
    dispatchEvent(event: DomEvent): boolean
    Event: new (type: string) => DomEvent
  }

  export interface JSDOMOptions {
    runScripts?: "dangerously"
    url?: string
    beforeParse?: (window: DomWindow) => void
  }

  export class JSDOM {
    constructor(html: string, options?: JSDOMOptions)
    readonly window: DomWindow
  }
}
