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
    /** True once a handler has called preventDefault on a cancelable event —
     *  how the paste test proves the binary didn't ALSO land as text. */
    readonly defaultPrevented: boolean
    /** Present on a `paste` event only; shaped by the test to mirror a
     *  browser's `DataTransfer` (items with kind/type/getAsFile). */
    clipboardData?: unknown
    /** Present on drag/drop events; shaped by the test to mirror a browser's
     *  `DataTransfer` (getData + files + dropEffect). */
    dataTransfer?: unknown
    /** Set by the test on a synthetic keydown to drive @mention navigation. */
    key?: string
    shiftKey?: boolean
  }

  /** A jsdom File — the paste handler reads its bytes and mime. */
  export interface DomFile {
    readonly type: string
    readonly name: string
    arrayBuffer(): Promise<ArrayBuffer>
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
    /** Caret position on <textarea>/<input> — drives @mention detection. */
    selectionStart?: number | null
    /** Selection end on <textarea>/<input> — equal to selectionStart when
     *  there is no selection (a bare caret). Drives the ↑/↓ history recall
     *  caret rule (no-selection-and-at-an-edge). */
    selectionEnd?: number | null
    /** Sets selectionStart/selectionEnd together — how a history recall
     *  parks the caret at the end after painting the recalled text. */
    setSelectionRange?(start: number, end: number): void
    /** Only meaningful on form controls (<button>, <textarea>). */
    disabled?: boolean
    hidden?: boolean
    /** Native tooltip text. */
    title?: string
    dispatchEvent(event: DomEvent): boolean
    querySelector(selectors: string): DomElement | null
    querySelectorAll(selectors: string): Iterable<DomElement>
  }

  export interface DomDocument {
    getElementById(id: string): DomElement | null
    dispatchEvent(event: DomEvent): boolean
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
    Event: new (type: string, init?: { cancelable?: boolean; bubbles?: boolean }) => DomEvent
    MessageEvent: new (type: string, init?: { data?: unknown }) => DomEvent
    KeyboardEvent: new (type: string, init?: { key?: string; bubbles?: boolean }) => DomEvent
    MutationObserver: new (callback: (records: unknown[]) => void) => DomMutationObserver
    File: new (bits: readonly unknown[], name: string, options?: { type?: string }) => DomFile
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
