/**
 * Minimal types for jsdom (it ships none, and @types/jsdom trails the pinned
 * major). Only the surface these tests touch: construct a window that runs
 * inline scripts, optionally patched before its first script executes.
 */
declare module "jsdom" {
  export type DOMWindow = Window & typeof globalThis

  export interface JSDOMOptions {
    runScripts?: "dangerously" | "outside-only"
    url?: string
    beforeParse?(window: DOMWindow): void
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions)
    readonly window: DOMWindow
  }
}
