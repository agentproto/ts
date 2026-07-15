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
import type {
  PresentedActivitySegment,
  PresentedConversation,
  PresentedTurn,
  PresentedToolSegment,
} from "./conversation.js"
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

describe("transcriptPanel webview — activity group folding", () => {
  const activity = (over: Partial<PresentedActivitySegment> = {}): PresentedActivitySegment => ({
    kind: "activity",
    id: "act-seg-1",
    summary: "2 steps",
    count: 2,
    status: "ok",
    children: [
      { kind: "reasoning", id: "seg-1", html: "thinking" },
      { kind: "tool", id: "tool-t1", toolName: "bash", isError: false, status: "ok", resultText: "ok" },
    ],
    ...over,
  })

  function initWith(panel: Panel, seg: PresentedActivitySegment): void {
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [{ id: "turn-1", role: "assistant", segments: [seg] }],
    }
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: conv })
  }

  it("renders the group COLLAPSED, showing only the summary row", () => {
    const panel = renderPanel()
    initWith(panel, activity())
    const node = segNode(panel, "act-seg-1")
    expect(node?.tagName).toBe("DETAILS")
    // The whole point: a long run must not spam a user waiting on the answer.
    expect(node?.open).toBeFalsy()
    expect(node?.querySelector(".act-label")?.textContent).toBe("2 steps")
    expect(node?.querySelector(".act-badge")?.textContent).toBe("✓")
  })

  it("nests the folded steps as a tree the user can open", () => {
    const panel = renderPanel()
    initWith(panel, activity())
    const kids = segNode(panel, "act-seg-1")?.querySelector(".act-children")
    expect(kids).not.toBeNull()
    expect([...(kids?.querySelectorAll(":scope > [data-seg-id]") ?? [])].map(n => n.dataset.segId)).toEqual([
      "seg-1",
      "tool-t1",
    ])
  })

  it("KEEPS the group open, and its opened child open, as a new step streams in", () => {
    const panel = renderPanel()
    initWith(panel, activity({ status: "pending", summary: "bash · 2 steps", pendingSince: new Date().toISOString() }))

    const group = segNode(panel, "act-seg-1")
    const child = segNode(panel, "tool-t1")
    if (!group || !child) throw new Error("unreachable")
    // The user opens the tree to watch, and expands one step inside it.
    group.open = true
    child.open = true

    const grown = activity({
      status: "pending",
      summary: "grep · 3 steps",
      count: 3,
      pendingSince: new Date().toISOString(),
      children: [
        { kind: "reasoning", id: "seg-1", html: "thinking" },
        { kind: "tool", id: "tool-t1", toolName: "bash", isError: false, status: "ok", resultText: "ok" },
        { kind: "tool", id: "tool-t2", toolName: "grep", isError: false, status: "pending" },
      ],
    })
    panel.send({
      type: "patch",
      upsertTurns: [{ id: "turn-1", role: "assistant", segments: [grown] }],
      removeTurnIds: [],
    })

    const groupAfter = segNode(panel, "act-seg-1")
    expect(groupAfter).toBe(group) // same node — never replaced
    expect(groupAfter?.open).toBe(true) // the tree the user opened stayed open
    expect(segNode(panel, "tool-t1")).toBe(child) // untouched child untouched
    expect(segNode(panel, "tool-t1")?.open).toBe(true)
    // ...and the summary tracks the step now actually running.
    expect(groupAfter?.querySelector(".act-label")?.textContent).toBe("grep · 3 steps")
    expect(segNode(panel, "tool-t2")).toBeDefined()
  })

  it("ticks the collapsed row's elapsed label so a pending fold still shows progress", () => {
    vi.useFakeTimers()
    const panel = renderPanel({ fakeTimers: true })
    initWith(
      panel,
      activity({
        status: "pending",
        summary: "bash · 2 steps",
        pendingSince: new Date(Date.now() - 3_000).toISOString(),
      }),
    )
    const node = segNode(panel, "act-seg-1")
    expect(node?.querySelector(".act-elapsed")?.textContent).toMatch(/^running · \d+s$/)
    expect(node?.classList.contains("tool-still-running")).toBe(false)

    vi.advanceTimersByTime(8_000) // ~11s total — past the escalation threshold

    expect(node?.querySelector(".act-elapsed")?.textContent).toMatch(/^still running · \d+s$/)
    // A fold that is quietly stuck must still say so from the collapsed row.
    expect(node?.classList.contains("tool-still-running")).toBe(true)
  })

  it("marks a group carrying a failed step so the fold never hides the failure", () => {
    const panel = renderPanel()
    initWith(panel, activity({ status: "error", summary: "2 steps · 1 failed" }))
    const node = segNode(panel, "act-seg-1")
    expect(node?.className).toContain("activity-error")
    expect(node?.querySelector(".act-badge")?.textContent).toBe("✗")
    expect(node?.querySelector(".act-label")?.textContent).toBe("2 steps · 1 failed")
  })
})

describe("transcriptPanel webview — composer", () => {
  const btn = (panel: Panel, id: string): DomElement => {
    const el = panel.document.getElementById(id)
    if (!el) throw new Error(id + " missing from buildHtml output")
    return el
  }

  function init(panel: Panel, over: Partial<SessionDescriptor> = {}): void {
    panel.send({
      type: "init",
      session: session(over),
      nonce: "n",
      mode: "structured",
      conversation: { version: 1, sessionId: "s1", turns: [] },
    })
  }

  it("names the agent and model in the composer bar, where the user types to them", () => {
    const panel = renderPanel()
    init(panel, { adapterSlug: "claude-code", model: "sonnet-5" })
    expect(btn(panel, "composer-adapter").textContent).toBe("claude-code")
    expect(btn(panel, "composer-model").textContent).toBe("sonnet-5")
    // ...and the header does not repeat them.
    expect(panel.document.getElementById("header-subtitle")).toBeNull()
  })

  it("keeps send inert until there is something to send", () => {
    const panel = renderPanel()
    init(panel)
    const send = btn(panel, "send")
    expect(send.disabled).toBe(true)
    expect(send.classList.contains("has-text")).toBe(false)

    const input = btn(panel, "input")
    input.value = "hello"
    input.dispatchEvent(new panel.window.Event("input"))

    expect(send.disabled).toBe(false)
    expect(send.classList.contains("has-text")).toBe(true)
  })

  it("hides interrupt unless the agent is actually busy", () => {
    const panel = renderPanel()
    init(panel, { busy: false })
    expect(btn(panel, "interrupt-send").hidden).toBe(true)

    panel.send({ type: "sessionUpdate", session: session({ busy: true }) })
    expect(btn(panel, "interrupt-send").hidden).toBe(false)
  })

  it("disables the composer and kill once the session is dead", () => {
    const panel = renderPanel()
    init(panel, { busy: true })
    expect(btn(panel, "kill").disabled).toBe(false)

    panel.send({ type: "sessionUpdate", session: session({ status: "exited", busy: false }) })

    expect(btn(panel, "input").disabled).toBe(true)
    expect(btn(panel, "send").disabled).toBe(true)
    expect(btn(panel, "kill").disabled).toBe(true)
    // Nothing to interrupt on a dead session.
    expect(btn(panel, "interrupt-send").hidden).toBe(true)
    expect(btn(panel, "composer").classList.contains("disabled")).toBe(true)
  })
})

describe("transcriptPanel webview — honest session state", () => {
  function init(panel: Panel, over: Partial<SessionDescriptor> = {}): void {
    panel.send({
      type: "init",
      session: session(over),
      nonce: "n",
      mode: "structured",
      conversation: { version: 1, sessionId: "s1", turns: [] },
    })
  }
  const el = (panel: Panel, id: string): DomElement => {
    const node = panel.document.getElementById(id)
    if (!node) throw new Error(id + " missing from buildHtml output")
    return node
  }

  it("shows blocked-on while a turn is actually in flight", () => {
    const panel = renderPanel()
    init(panel, { status: "running", busy: true, blockedOn: "command", pendingToolCallId: "toolu_01ABCDEF" })
    expect(el(panel, "header-blocked").textContent).toBe("blocked on command · toolu_01")
  })

  it("does NOT claim a killed session is blocked (stale blockedOn survives the kill)", () => {
    const panel = renderPanel()
    // The real descriptor a killed-mid-tool-call session carries: the daemon
    // clears blockedOn in the turn's finally, which never runs here.
    init(panel, { status: "killed", busy: true, blockedOn: "command", pendingToolCallId: "toolu_01ABCDEF" })
    expect(el(panel, "header-blocked").textContent).toBe("")
    // ...and the chip must not contradict it either.
    expect(el(panel, "status-chip").textContent).toBe("exited")
  })

  it("renders context as an integer percent, keeping the raw counts in the tooltip", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session(),
      nonce: "n",
      mode: "structured",
      conversation: {
        version: 1,
        sessionId: "s1",
        turns: [],
        usage: { seq: 1, contextUsed: 206_115, contextSize: 1_000_000, tokensIn: 5, tokensOut: 7 },
      },
    })
    const usage = el(panel, "conv-usage")
    expect(usage.textContent).toBe("ctx 21% · in 5 · out 7")
    expect(usage.title).toBe("context 206115 / 1000000")
  })

  it("omits the context percent rather than dividing by zero", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session(),
      nonce: "n",
      mode: "structured",
      conversation: { version: 1, sessionId: "s1", turns: [], usage: { seq: 1, contextUsed: 5, contextSize: 0 } },
    })
    expect(el(panel, "conv-usage").textContent).toBe("")
  })

  it("shows the working row with a ticking elapsed only while busy", () => {
    vi.useFakeTimers()
    const panel = renderPanel({ fakeTimers: true })
    init(panel, { status: "running", busy: true, tokensOut: 983 })

    const row = el(panel, "working")
    expect(row.hidden).toBe(false)
    expect(el(panel, "working-text").textContent).toBe("Working… · 0s · 983 tokens")

    vi.advanceTimersByTime(5_000)
    expect(el(panel, "working-text").textContent).toBe("Working… · 5s · 983 tokens")

    panel.send({ type: "sessionUpdate", session: session({ status: "running", busy: false }) })
    expect(row.hidden).toBe(true)
  })

  it("never spins the working row for a killed session carrying a stale busy flag", () => {
    const panel = renderPanel()
    init(panel, { status: "killed", busy: true })
    expect(el(panel, "working").hidden).toBe(true)
  })
})
