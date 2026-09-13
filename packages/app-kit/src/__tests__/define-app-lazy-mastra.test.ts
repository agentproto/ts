/**
 * Regression guard: `defineApp()` must not statically import
 * `@agentproto/mastra` (and therefore `@mastra/core`) — that chain is a
 * documented peer dependency (see ../index.ts), and a static top-level
 * import would force any bundler that traces into `define-app.js` to inline
 * it even for a caller that never calls `toMastraAgent(s)` (e.g. a UI-only
 * app). This bit `packages/vscode`'s extension bundle once already: adding
 * an app-kit import to a panel's `index.ts` pulled `@mastra/core` (and its
 * `@ast-grep/napi` native binary) into the whole extension.js.
 *
 * `@agentproto/mastra` is mocked to throw on import — if `define-app.js`
 * (or anything it statically imports) still reaches for it at module-load
 * time, importing `defineApp` itself would throw and this test would fail
 * before ever calling it.
 */

import { describe, it, expect, vi } from "vitest"

vi.mock("@agentproto/mastra", () => {
  throw new Error("@agentproto/mastra must not be imported eagerly by defineApp()")
})

describe("defineApp — does not eagerly import @agentproto/mastra", () => {
  it("constructs a UI-only handle without touching @agentproto/mastra", async () => {
    const { defineApp } = await import("../define-app.js")
    const handle = defineApp({
      agents: [],
      ui: { html: "<html></html>" },
    })
    expect(handle.agents).toEqual([])
    expect(handle.ui?.html).toBe("<html></html>")
  })
})
