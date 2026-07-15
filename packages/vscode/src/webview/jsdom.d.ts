/**
 * Minimal ambient DOM + jsdom types for transcriptPanel.dom.test.ts.
 *
 * packages/vscode's tsconfig deliberately excludes the "DOM" lib (it's a
 * Node-only VS Code extension host), so lib.dom.d.ts's Window/Document/
 * Element aren't available here, and jsdom itself ships no types (and
 * @types/jsdom stops one major behind the version pinned in package.json).
 * This hand-declares exactly the surface the DOM test touches — scoped
 * inside the "jsdom" module augmentation — so that test stays fully typed
 * without widening the whole package's ambient globals via tsconfig or
 * pulling in another dependency.
 */
declare module "jsdom" {
  export interface DomEvent {
    readonly type: string
  }

  export interface DomClassList {
    contains(className: string): boolean
  }

  export interface DomDOMStringMap {
    readonly [key: string]: string | undefined
  }

  export interface DomElement {
    readonly tagName: string
    className: string
    readonly classList: DomClassList
    innerHTML: string
    textContent: string | null
    readonly dataset: DomDOMStringMap
    /** Only meaningful on <details> elements. */
    open?: boolean
    /** Only meaningful on <textarea>/<input>. */
    value?: string
    /** Only meaningful on form controls (<button>, <textarea>). */
    disabled?: boolean
    hidden?: boolean
    dispatchEvent(event: DomEvent): boolean
    querySelector(selectors: string): DomElement | null
    querySelectorAll(selectors: string): Iterable<DomElement>
  }

  export interface DomDocument {
    getElementById(id: string): DomElement | null
  }

  export interface DomMutationObserverInit {
    childList?: boolean
    subtree?: boolean
    attributes?: boolean
    characterData?: boolean
  }

  export interface DomMutationObserver {
    observe(target: DomElement, options: DomMutationObserverInit): void
    disconnect(): void
    takeRecords(): unknown[]
  }

  export interface DomWindow {
    readonly document: DomDocument
    Date: DateConstructor
    setInterval: (handler: () => void, timeoutMs?: number) => unknown
    clearInterval: (id?: unknown) => void
    close(): void
    acquireVsCodeApi?: () => {
      postMessage: (msg: unknown) => void
      getState: () => unknown
      setState: (state: unknown) => void
    }
    dispatchEvent(event: DomEvent): boolean
    Event: new (type: string) => DomEvent
    MessageEvent: new (type: string, init?: { data?: unknown }) => DomEvent
    MutationObserver: new (callback: (records: unknown[]) => void) => DomMutationObserver
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
