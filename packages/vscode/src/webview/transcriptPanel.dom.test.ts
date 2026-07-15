// @vitest-environment jsdom
/**
 * DOM-level regression coverage for the webview's patch reconciliation.
 *
 * conversationPatch.test.ts covers the pure turn-level diff; THIS file covers
 * the part that actually touches the DOM — patching in place instead of
 * tearing the timeline down on every poll tick, which is the entire point of
 * WP4. It extracts and executes the REAL shipped HTML/script via the
 * exported `buildHtml`, in a real jsdom document, rather than re-describing
 * the reconciliation logic as a copy — so a regression in the shipped script
 * fails this suite, not just a hand-rolled model of it.
 *
 * Kept off the `node` environment used by the other 238 (pure-logic) tests —
 * only this file pays the jsdom cost, via the per-file docblock above. Types
 * for jsdom/the DOM surface used here are hand-declared in jsdom.d.ts (see
 * that file's header for why).
 */
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it, vi } from "vitest"

import { buildHtml } from "./transcriptPanel.js"
import type { ExtMessage } from "./protocol.js"
import type { PresentedConversation, PresentedTurn, PresentedToolSegment } from "./conversation.js"
import type { SessionDescriptor } from "../client/types.js"
import type { DomWindow, DomDocument, DomElement } from "jsdom"

interface Panel {
  window: DomWindow
  document: DomDocument
  transcript: DomElement
  send: (msg: ExtMessage) => void
}

// Windows created via `new JSDOM(...)` schedule REAL underlying timers for
// the webview's elapsed-time ticker (setInterval). Every one opened by a
// test is tracked here and closed in afterEach so no interval outlives its
// test and keeps the process/event loop busy.
const openWindows: DomWindow[] = []

interface RenderOptions {
  /** Wire window.Date/setInterval to the CURRENT globals — only useful once
   *  vi.useFakeTimers() has already patched those, so the ticker can be
   *  driven with vi.advanceTimersByTime instead of a real sleep. */
  fakeTimers?: boolean
}

function renderPanel(opts: RenderOptions = {}): Panel {
  const dom = new JSDOM(buildHtml("test-nonce"), {
    runScripts: "dangerously",
    url: "https://example.test/",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        postMessage: () => {},
        getState: () => undefined,
        setState: () => {},
      })
      if (opts.fakeTimers) {
        // DateConstructor is the same ambient type in both realms — a
        // direct assignment, no cast needed. setInterval's real return
        // (NodeJS.Timeout) is assignable to our own `unknown`-typed
        // DomWindow.setInterval, so no cast is needed there either.
        window.Date = Date
        window.setInterval = (handler, timeoutMs) => setInterval(handler, timeoutMs)
        window.clearInterval = () => {} // never invoked by the shipped script
      }
    },
  })
  openWindows.push(dom.window)
  const { window } = dom
  const { document } = window
  const transcript = document.getElementById("transcript")
  if (!transcript) throw new Error("transcript element missing from buildHtml output")
  return {
    window,
    document,
    transcript,
    send: msg => window.dispatchEvent(new window.MessageEvent("message", { data: msg })),
  }
}

function session(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "cmd",
    pid: 1,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  }
}

function turnNodes(panel: Panel): DomElement[] {
  return [...panel.transcript.querySelectorAll(".turn[data-turn-id]")]
}

function segNode(panel: Panel, segId: string): DomElement | undefined {
  return [...panel.transcript.querySelectorAll("[data-seg-id]")].find(n => n.dataset.segId === segId)
}

afterEach(() => {
  vi.useRealTimers()
  for (const w of openWindows.splice(0)) w.close()
})

describe("transcriptPanel webview — DOM patch reconciliation", () => {
  it("keeps the SAME <details> node and its open state across a pending -> ok tool transition", () => {
    const panel = renderPanel()
    const pendingSeg: PresentedToolSegment = {
      kind: "tool",
      id: "tool-t1",
      toolName: "bash",
      argsText: "ls",
      isError: false,
      status: "pending",
      ts: new Date(Date.now() - 2000).toISOString(),
    }
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [{ id: "turn-1", role: "assistant", segments: [pendingSeg] }],
    }
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: conv })

    const before = segNode(panel, "tool-t1")
    expect(before).toBeDefined()
    if (!before) throw new Error("unreachable")
    expect(before.tagName).toBe("DETAILS")
    // Simulate the user expanding the pending tool card to watch it.
    before.open = true

    const resolvedSeg: PresentedToolSegment = { ...pendingSeg, status: "ok", resultText: "file.txt" }
    const resolvedTurn: PresentedTurn = { id: "turn-1", role: "assistant", segments: [resolvedSeg] }
    panel.send({ type: "patch", upsertTurns: [resolvedTurn], removeTurnIds: [] })

    const after = segNode(panel, "tool-t1")
    expect(after).toBe(before) // same node — never replaced
    expect(after?.open).toBe(true) // <details open> survived the content update
    expect(after?.className).toContain("tool-ok")
    expect(after?.querySelector(".tool-pending-row")).toBeNull()
    expect(after?.querySelector(".tool-result")).not.toBeNull()
  })

  it("leaves untouched turns and segments referentially identical (===) across a patch touching one turn", () => {
    const panel = renderPanel()
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [
        { id: "turn-1", role: "user", segments: [{ kind: "user", id: "seg-1", html: "hello" }] },
        {
          id: "turn-2",
          role: "assistant",
          segments: [
            { kind: "reasoning", id: "seg-2", html: "thinking" },
            { kind: "assistant-text", id: "seg-3", html: "Hi" },
          ],
        },
      ],
    }
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: conv })

    const turn1Before = turnNodes(panel).find(n => n.dataset.turnId === "turn-1")
    const turn2Before = turnNodes(panel).find(n => n.dataset.turnId === "turn-2")
    const reasoningBefore = segNode(panel, "seg-2")

    // Only the streaming assistant-text segment (seg-3) actually changed.
    const updatedTurn2: PresentedTurn = {
      id: "turn-2",
      role: "assistant",
      segments: [
        { kind: "reasoning", id: "seg-2", html: "thinking" }, // identical content
        { kind: "assistant-text", id: "seg-3", html: "Hi there" }, // changed
      ],
    }
    panel.send({ type: "patch", upsertTurns: [updatedTurn2], removeTurnIds: [] })

    const turn1After = turnNodes(panel).find(n => n.dataset.turnId === "turn-1")
    const turn2After = turnNodes(panel).find(n => n.dataset.turnId === "turn-2")
    const reasoningAfter = segNode(panel, "seg-2")

    expect(turn1After).toBe(turn1Before) // turn-1 wasn't in the patch at all
    expect(turn2After).toBe(turn2Before) // turn-2 reconciled IN PLACE, not rebuilt
    expect(reasoningAfter).toBe(reasoningBefore) // unchanged segment untouched
    expect(segNode(panel, "seg-3")?.innerHTML).toBe("Hi there")
  })

  it("inserts a late-arriving EARLIER turn before a newer one already rendered, not appended after it", () => {
    const panel = renderPanel()
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [{ id: "turn-5", role: "user", segments: [{ kind: "user", id: "seg-5", html: "later" }] }],
    }
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: conv })

    const earlierTurn: PresentedTurn = {
      id: "turn-2",
      role: "user",
      segments: [{ kind: "user", id: "seg-2", html: "earlier" }],
    }
    panel.send({ type: "patch", upsertTurns: [earlierTurn], removeTurnIds: [] })

    const order = turnNodes(panel).map(n => n.dataset.turnId)
    expect(order).toEqual(["turn-2", "turn-5"])
  })

  it("mutates ZERO DOM nodes for an empty/no-op patch", () => {
    const panel = renderPanel()
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [{ id: "turn-1", role: "user", segments: [{ kind: "user", id: "seg-1", html: "hello" }] }],
    }
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: conv })

    const observer = new panel.window.MutationObserver(() => {})
    observer.observe(panel.transcript, { childList: true, subtree: true, attributes: true, characterData: true })

    panel.send({ type: "patch", upsertTurns: [], removeTurnIds: [] })

    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
  })

  it("ticks a pending tool's elapsed label and shows the ~10s escalation affordance", () => {
    vi.useFakeTimers()
    const panel = renderPanel({ fakeTimers: true })
    const startedAt = new Date(Date.now() - 3_000).toISOString() // 3s old — not escalated yet
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [
        {
          id: "turn-1",
          role: "assistant",
          segments: [
            { kind: "tool", id: "tool-t1", toolName: "bash", isError: false, status: "pending", ts: startedAt },
          ],
        },
      ],
    }
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: conv })

    const node = segNode(panel, "tool-t1")
    const labelBefore = node?.querySelector(".tool-elapsed")?.textContent ?? ""
    // The pending row paints its elapsed time immediately on creation, ahead
    // of the first tick — must not need a full second before showing anything.
    expect(labelBefore).toMatch(/^running · \d+s$/)
    expect(node?.classList.contains("tool-still-running")).toBe(false)

    vi.advanceTimersByTime(8_000) // total elapsed now ~11s — past the 10s threshold

    const labelAfter = node?.querySelector(".tool-elapsed")?.textContent ?? ""
    expect(labelAfter).toMatch(/^still running · \d+s$/)
    expect(node?.classList.contains("tool-still-running")).toBe(true)
  })
})
