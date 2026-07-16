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
import type { DomWindow, DomDocument, DomElement, DomEvent } from "jsdom"

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
  /** Observe what the webview posts BACK to the host — the only way to assert
   *  that a mid-turn message was withheld rather than sent. */
  onPost?: (msg: unknown) => void
}

function renderPanel(opts: RenderOptions = {}): Panel {
  const dom = new JSDOM(buildHtml("test-nonce"), {
    runScripts: "dangerously",
    url: "https://example.test/",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        postMessage: (msg: unknown) => opts.onPost?.(msg),
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
    // The live dot lives in the summary now, and a settled step has none.
    expect(after?.querySelector(".seg-dot")).toBeNull()
    expect(after?.querySelector(".seg-badge")?.textContent).toBe("✓")
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
    const labelBefore = node?.querySelector(".seg-elapsed")?.textContent ?? ""
    // The pending row paints its elapsed time immediately on creation, ahead
    // of the first tick — must not need a full second before showing anything.
    expect(labelBefore).toMatch(/^running · \d+s$/)
    expect(node?.classList.contains("tool-still-running")).toBe(false)

    vi.advanceTimersByTime(8_000) // total elapsed now ~11s — past the 10s threshold

    const labelAfter = node?.querySelector(".seg-elapsed")?.textContent ?? ""
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
    expect(node?.querySelector(".seg-label")?.textContent).toBe("2 steps")
    expect(node?.querySelector(".seg-badge")?.textContent).toBe("✓")
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
    expect(groupAfter?.querySelector(".seg-label")?.textContent).toBe("grep · 3 steps")
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
    expect(node?.querySelector(".seg-elapsed")?.textContent).toMatch(/^running · \d+s$/)
    expect(node?.classList.contains("tool-still-running")).toBe(false)

    vi.advanceTimersByTime(8_000) // ~11s total — past the escalation threshold

    expect(node?.querySelector(".seg-elapsed")?.textContent).toMatch(/^still running · \d+s$/)
    // A fold that is quietly stuck must still say so from the collapsed row.
    expect(node?.classList.contains("tool-still-running")).toBe(true)
  })

  it("marks a group carrying a failed step so the fold never hides the failure", () => {
    const panel = renderPanel()
    initWith(panel, activity({ status: "error", summary: "2 steps · 1 failed" }))
    const node = segNode(panel, "act-seg-1")
    expect(node?.className).toContain("activity-error")
    expect(node?.querySelector(".seg-badge")?.textContent).toBe("✗")
    expect(node?.querySelector(".seg-label")?.textContent).toBe("2 steps · 1 failed")
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
    expect(btn(panel, "composer-harness").textContent).toBe("claude-code")
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

  it("hides interrupt until a message is actually waiting — busy alone is not enough", () => {
    const panel = renderPanel()
    init(panel, { busy: true })
    // The agent is working, but nothing is queued: there is nothing to force.
    expect(btn(panel, "interrupt-send").hidden).toBe(true)
  })

  it("disables the composer once the session is dead", () => {
    const panel = renderPanel()
    init(panel, { busy: true })

    panel.send({ type: "sessionUpdate", session: session({ status: "exited", busy: false }) })

    expect(btn(panel, "input").disabled).toBe(true)
    expect(btn(panel, "send").disabled).toBe(true)
    expect(btn(panel, "interrupt-send").hidden).toBe(true)
    expect(btn(panel, "composer").classList.contains("disabled")).toBe(true)
  })

  it("has no kill button — killing lives in the sessions tree", () => {
    const panel = renderPanel()
    init(panel)
    expect(panel.document.getElementById("kill")).toBeNull()
  })
})

describe("transcriptPanel webview — header title", () => {
  const el = (panel: Panel, id: string): DomElement => {
    const node = panel.document.getElementById(id)
    if (!node) throw new Error(id + " missing from buildHtml output")
    return node
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

  it("renders the derived title when label is absent — the header used to show the raw session id instead", () => {
    const panel = renderPanel()
    init(panel, { label: undefined, title: "Fix the auth bug", id: "sess_09ed741a" })
    expect(el(panel, "header-title").textContent).toBe("Fix the auth bug")
  })

  it("still prefers label over the derived title when both are present", () => {
    const panel = renderPanel()
    init(panel, { label: "My renamed session", title: "Fix the auth bug" })
    expect(el(panel, "header-title").textContent).toBe("My renamed session")
  })

  it("falls back to the id when neither label nor title exist yet — pre-#390 sessions self-heal on their next prompt", () => {
    const panel = renderPanel()
    init(panel, { label: undefined, title: undefined, id: "sess_09ed741a" })
    expect(el(panel, "header-title").textContent).toBe("sess_09ed741a")
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

  it("renders the context percent on the context button, keeping the raw counts for the popover", () => {
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
    // in/out dropped: they repeated the cost button in the same header, and a
    // raw token total isn't a number anyone acts on.
    expect(el(panel, "context-btn").textContent).toBe("ctx 21%")
  })

  it("hides the context button rather than dividing by zero", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session(),
      nonce: "n",
      mode: "structured",
      conversation: { version: 1, sessionId: "s1", turns: [], usage: { seq: 1, contextUsed: 5, contextSize: 0 } },
    })
    // A button reading "undefined" is worse than a button that isn't there.
    expect(el(panel, "context-btn").textContent).toBe("")
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

describe("transcriptPanel webview — blocked-on note", () => {
  const el = (panel: Panel, id: string): DomElement => {
    const node = panel.document.getElementById(id)
    if (!node) throw new Error(id + " missing from buildHtml output")
    return node
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

  it("stays absent the instant a turn touches a tool — almost every block clears in a second or two", () => {
    vi.useFakeTimers()
    const panel = renderPanel({ fakeTimers: true })
    init(panel, { status: "running", busy: true, blockedOn: "command", pendingToolCallId: "toolu_01ABCDEF" })
    expect(el(panel, "blocked-note").hidden).toBe(true)
  })

  it("appears once the block outlasts the ~20s delay", () => {
    vi.useFakeTimers()
    const panel = renderPanel({ fakeTimers: true })
    init(panel, { status: "running", busy: true, blockedOn: "command", pendingToolCallId: "toolu_01ABCDEF" })

    vi.advanceTimersByTime(19_000)
    expect(el(panel, "blocked-note").hidden).toBe(true)

    vi.advanceTimersByTime(1_000) // total 20s
    expect(el(panel, "blocked-note").hidden).toBe(false)
    expect(el(panel, "blocked-note").textContent).toBe("blocked on command · toolu_01")
  })

  it("clears the instant the tool returns, without waiting", () => {
    vi.useFakeTimers()
    const panel = renderPanel({ fakeTimers: true })
    init(panel, { status: "running", busy: true, blockedOn: "command", pendingToolCallId: "toolu_01ABCDEF" })
    vi.advanceTimersByTime(20_000)
    expect(el(panel, "blocked-note").hidden).toBe(false)

    panel.send({ type: "sessionUpdate", session: session({ status: "running", busy: true, blockedOn: undefined }) })
    expect(el(panel, "blocked-note").hidden).toBe(true)
  })

  it("does NOT claim a killed session is blocked, even past the delay (stale blockedOn survives the kill)", () => {
    vi.useFakeTimers()
    const panel = renderPanel({ fakeTimers: true })
    // The real descriptor a killed-mid-tool-call session carries: the daemon
    // clears blockedOn in the turn's finally, which never runs here.
    init(panel, { status: "killed", busy: true, blockedOn: "command", pendingToolCallId: "toolu_01ABCDEF" })
    vi.advanceTimersByTime(30_000)
    expect(el(panel, "blocked-note").hidden).toBe(true)
    expect(el(panel, "blocked-note").textContent).toBe("")
  })
})

describe("transcriptPanel webview — typing mid-turn queues instead of erroring", () => {
  const el = (panel: Panel, id: string): DomElement => {
    const node = panel.document.getElementById(id)
    if (!node) throw new Error(id + " missing from buildHtml output")
    return node
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
  function type(panel: Panel, text: string): void {
    const input = el(panel, "input")
    input.value = text
    input.dispatchEvent(new panel.window.Event("input"))
  }

  it("holds a message typed mid-turn rather than posting a prompt the daemon would 409", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, { busy: true })

    type(panel, "also fix the tests")
    el(panel, "send").dispatchEvent(new panel.window.Event("click"))

    // Nothing went to the daemon — the agent is mid-turn.
    expect(posted.filter(m => (m as { type: string }).type === "send")).toEqual([])
    expect(el(panel, "queued").hidden).toBe(false)
    expect(el(panel, "queued-label").textContent).toBe("Queued · also fix the tests")
    // No error anywhere: typing while it works is normal.
    expect(el(panel, "error-banner").hidden).toBe(true)
    // ...and NOW there is something to force.
    expect(el(panel, "interrupt-send").hidden).toBe(false)
    expect(el(panel, "input").value).toBe("")
  })

  it("flushes the queued message when the turn ends", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, { busy: true })
    type(panel, "next task")
    el(panel, "send").dispatchEvent(new panel.window.Event("click"))
    expect(posted.filter(m => (m as { type: string }).type === "send")).toEqual([])

    panel.send({ type: "sessionUpdate", session: session({ busy: false }) })

    expect(posted).toContainEqual({ type: "send", text: "next task" })
    expect(el(panel, "queued").hidden).toBe(true)
    expect(el(panel, "interrupt-send").hidden).toBe(true)
  })

  it("interrupt & send forces the queued message immediately", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, { busy: true })
    type(panel, "stop and do this")
    el(panel, "send").dispatchEvent(new panel.window.Event("click"))

    el(panel, "interrupt-send").dispatchEvent(new panel.window.Event("click"))

    expect(posted).toContainEqual({ type: "interruptSend", text: "stop and do this" })
    expect(el(panel, "queued").hidden).toBe(true)
  })

  it("cancelling the queued message drops it — it must not fire on turn-end", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, { busy: true })
    type(panel, "never mind")
    el(panel, "send").dispatchEvent(new panel.window.Event("click"))

    el(panel, "queued-cancel").dispatchEvent(new panel.window.Event("click"))
    panel.send({ type: "sessionUpdate", session: session({ busy: false }) })

    expect(posted.filter(m => (m as { type: string }).type === "send")).toEqual([])
    expect(el(panel, "queued").hidden).toBe(true)
  })

  it("re-queues rather than erroring when a 409 wins the race against the busy check", () => {
    const panel = renderPanel()
    init(panel, { busy: false }) // idle as far as the panel knows, so it posts
    panel.send({
      type: "sendError",
      kind: "busy",
      title: "Agent is mid-turn",
      message: 'HTTP 409 ... is mid-turn — wait for it to finish or cancel',
      text: "raced message",
    })
    expect(el(panel, "error-banner").hidden).toBe(true)
    expect(el(panel, "queued-label").textContent).toBe("Queued · raced message")
  })

  it("shows a REAL failure in the banner, with the daemon's full message intact", () => {
    const panel = renderPanel()
    init(panel)
    const message = "POST /sessions/s1/prompt?wait=false failed: ECONNREFUSED 127.0.0.1:18790"
    panel.send({ type: "sendError", kind: "other", title: "Send failed", message, text: "hi" })

    expect(el(panel, "error-banner").hidden).toBe(false)
    expect(el(panel, "eb-title").textContent).toBe("Send failed")
    // Never clipped — the old one-line red text truncated the reason mid-sentence.
    expect(el(panel, "eb-message").textContent).toBe(message)
    expect(el(panel, "queued").hidden).toBe(true)

    el(panel, "eb-dismiss").dispatchEvent(new panel.window.Event("click"))
    expect(el(panel, "error-banner").hidden).toBe(true)
  })

  it("names the harness, model and auth mode in the composer bar", () => {
    const panel = renderPanel()
    init(panel, {
      adapterSlug: "claude-code",
      model: "sonnet-5",
      auth: { mode: "subscription", fingerprint: "abc" },
    })
    expect(el(panel, "composer-harness").textContent).toBe("claude-code")
    expect(el(panel, "composer-model").textContent).toBe("sonnet-5")
    expect(el(panel, "composer-auth").textContent).toBe("subscription")
  })
})

describe("transcriptPanel webview — working / waiting / stalled", () => {
  const el = (panel: Panel, id: string): DomElement => {
    const node = panel.document.getElementById(id)
    if (!node) throw new Error(id + " missing from buildHtml output")
    return node
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
  const fresh = (): string => new Date().toISOString()

  it("says WORKING, not BUSY, while the agent is generating", () => {
    const panel = renderPanel()
    init(panel, { busy: true, lastActivityAt: fresh() })
    expect(el(panel, "working-text").textContent).toContain("Working…")
  })

  it("says WAITING when the turn is parked on a background command — not the model being slow", () => {
    const panel = renderPanel()
    init(panel, { busy: true, blockedOn: "command", lastActivityAt: fresh() })
    expect(el(panel, "working-text").textContent).toContain("Waiting on command…")
  })

  it("says STALLED for a session silent past the threshold, and stops pretending to work", () => {
    const panel = renderPanel()
    // sess_be75fcdd's real shape: busy, but nothing emitted for 20h.
    const longAgo = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString()
    init(panel, { busy: true, lastActivityAt: longAgo, lastOutputAt: longAgo })

    const text = el(panel, "working-text").textContent ?? ""
    expect(text).toContain("Stalled")
    expect(text).toContain("no output for 20h")
    // The cheerful climbing counter was the lie — it must be gone.
    expect(text).not.toContain("Working…")
    expect(el(panel, "working").classList.contains("stalled")).toBe(true)
  })

  it("shows cost WITHOUT repeating the token counts", () => {
    const panel = renderPanel()
    init(panel, { costUsd: 0.03, tokensIn: 68694, tokensOut: 141 })
    // in/out used to render here AND again in #context-btn, in the same header.
    expect(el(panel, "cost-btn").textContent).toBe("$0.0300")
    expect(el(panel, "cost-btn").textContent).not.toContain("in ")
  })

  it("shows context fill WITHOUT the token counts trailing it", () => {
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
        usage: { seq: 1, contextUsed: 60_000, contextSize: 1_000_000, tokensIn: 68_694, tokensOut: 141 },
      },
    })
    expect(el(panel, "context-btn").textContent).toBe("ctx 6%")
  })
})

describe("transcriptPanel webview — a step is a row, not a box", () => {
  function initRow(panel: Panel, seg: PresentedToolSegment | PresentedActivitySegment): void {
    panel.send({
      type: "init",
      session: session(),
      nonce: "n",
      mode: "structured",
      conversation: {
        version: 1,
        sessionId: "s1",
        turns: [{ id: "turn-1", role: "assistant", segments: [seg] }],
      },
    })
  }

  const step = (over: Partial<PresentedToolSegment> = {}): PresentedToolSegment => ({
    kind: "tool",
    id: "tool-t1",
    toolName: "Terminal",
    isError: false,
    status: "ok",
    ...over,
  })

  it("puts status on the left and the chevron last, on the right", () => {
    const panel = renderPanel()
    initRow(panel, step())
    const summary = segNode(panel, "tool-t1")?.querySelector("summary")
    const order = [...(summary?.querySelectorAll("span") ?? [])].map(n => n.className)
    expect(order[0]).toContain("seg-badge")
    expect(order[1]).toContain("seg-label")
    // Last, and CSS pushes it right with margin-left:auto. The native
    // <details> triangle is gone — it was stuck on the left, fighting the
    // status glyph for the first thing the eye lands on.
    expect(order[order.length - 1]).toContain("seg-chev")
  })

  it("marks the running step with a dot and ticks its elapsed in the SUMMARY", () => {
    const panel = renderPanel()
    initRow(panel, step({ status: "pending", ts: new Date(Date.now() - 35_000).toISOString() }))
    const summary = segNode(panel, "tool-t1")?.querySelector("summary")
    // A dot, not a glyph: the eye finds the live step without reading a word.
    expect(summary?.querySelector(".seg-dot")).not.toBeNull()
    // In the summary, because the body is exactly what a collapsed card hides.
    expect(summary?.querySelector(".seg-elapsed")?.textContent).toMatch(/\d+s$/)
  })

  it("reports a failure with a red cross and nothing else", () => {
    const panel = renderPanel()
    initRow(panel, step({ status: "error", isError: true }))
    const node = segNode(panel, "tool-t1")
    const badge = node?.querySelector(".seg-badge")
    expect(badge?.textContent).toBe("✗")
    // The cross IS the failure report. It used to draw a red border around
    // its own row, inside a group that drew a red border too — one failure
    // shouting twice in nested boxes, while the ✗ itself was uncoloured.
    expect(badge?.className).toContain("badge-error")
  })

  it("gives a group the same row grammar as the steps inside it", () => {
    const panel = renderPanel()
    initRow(panel, {
      kind: "activity",
      id: "act-seg-1",
      summary: "2 steps · 1 failed",
      count: 2,
      status: "error",
      children: [
        { kind: "tool", id: "tool-a", toolName: "Terminal", isError: true, status: "error" },
        { kind: "tool", id: "tool-b", toolName: "Read File", isError: false, status: "ok" },
      ],
    })
    const summary = segNode(panel, "act-seg-1")?.querySelector("summary")
    expect(summary?.querySelector(".seg-badge")?.textContent).toBe("✗")
    expect(summary?.querySelector(".seg-label")?.textContent).toBe("2 steps · 1 failed")
    expect(summary?.querySelector(".seg-chev")).not.toBeNull()
  })
})

describe("transcriptPanel webview — pasting an image", () => {
  const el = (panel: Panel, id: string): DomElement => {
    const node = panel.document.getElementById(id)
    if (!node) throw new Error(id + " missing from buildHtml output")
    return node
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
  // Build a paste event carrying clipboard items — jsdom has no ClipboardEvent
  // or DataTransfer, so we hand the handler the same shape a browser would:
  // `clipboardData.items` with `kind`/`type`/`getAsFile()`. cancelable so the
  // handler's preventDefault is observable via defaultPrevented.
  function pasteEvent(
    panel: Panel,
    items: Array<{ kind: string; type: string; file?: unknown }>,
  ): DomEvent {
    const ev = new panel.window.Event("paste", { cancelable: true })
    ev.clipboardData = {
      items: items.map(it => ({ kind: it.kind, type: it.type, getAsFile: () => it.file ?? null })),
    }
    return ev
  }
  const flush = async (): Promise<void> => {
    // file.arrayBuffer() resolves on a later microtask; give it a real tick.
    await new Promise(res => setTimeout(res, 0))
    await new Promise(res => setTimeout(res, 0))
  }

  it("reads a pasted image to bytes and posts attachImage, preventing the garbage-text paste", async () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel)
    const input = el(panel, "input")
    const file = new panel.window.File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" })
    const ev = pasteEvent(panel, [{ kind: "file", type: "image/png", file }])

    input.dispatchEvent(ev)
    // The binary must not ALSO land as text — that was the whole reason to
    // intercept the paste.
    expect(ev.defaultPrevented).toBe(true)
    await flush()

    const attach = posted.filter(m => (m as { type?: string }).type === "attachImage") as Array<{
      type: string
      mime: string
      bytes: { byteLength: number }
    }>
    expect(attach).toHaveLength(1)
    expect(attach[0]!.mime).toBe("image/png")
    // Real bytes crossed the boundary — 4 of them — not a base64 string.
    expect(attach[0]!.bytes.byteLength).toBe(4)
  })

  it("ignores a plain-text paste — no attachImage, and the normal paste is left alone", async () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel)
    const input = el(panel, "input")
    const ev = pasteEvent(panel, [{ kind: "string", type: "text/plain" }])

    input.dispatchEvent(ev)
    await flush()

    expect(posted.filter(m => (m as { type?: string }).type === "attachImage")).toEqual([])
    // Not intercepted — the browser's own text paste proceeds.
    expect(ev.defaultPrevented).toBe(false)
  })

  it("inserts an uploaded path into the composer as text, spaced off from what's already there", () => {
    const panel = renderPanel()
    init(panel)
    const input = el(panel, "input")
    input.value = "look at"

    panel.send({ type: "attachmentUploaded", path: "/home/.agentproto/.agentproto-attachments/paste.png" })

    // Space-separated from the existing words, and a trailing space to keep
    // typing after it.
    expect(input.value).toBe("look at /home/.agentproto/.agentproto-attachments/paste.png ")
  })

  it("does not prepend a leading space when the composer was empty", () => {
    const panel = renderPanel()
    init(panel)
    const input = el(panel, "input")

    panel.send({ type: "attachmentUploaded", path: "/a/b.png" })

    expect(input.value).toBe("/a/b.png ")
  })

  it("shows an upload failure in the error banner rather than dropping it silently", () => {
    const panel = renderPanel()
    init(panel)

    panel.send({ type: "attachError", title: "Attachment upload failed", message: "HTTP 413 file_too_large" })

    expect(el(panel, "error-banner").hidden).toBe(false)
    expect(el(panel, "eb-title").textContent).toBe("Attachment upload failed")
    expect(el(panel, "eb-message").textContent).toBe("HTTP 413 file_too_large")
  })
})

describe("transcriptPanel webview — tool IO opens in an editor", () => {
  function initWithTool(panel: Panel, tool: PresentedToolSegment): void {
    panel.send({
      type: "init",
      session: session(),
      nonce: "n",
      mode: "structured",
      conversation: {
        version: 1,
        sessionId: "s1",
        turns: [{ id: "turn-1", role: "assistant", segments: [tool] }],
      },
    })
  }

  const clampedTool: PresentedToolSegment = {
    kind: "tool",
    id: "tool-t1",
    toolName: "Bash",
    isError: false,
    status: "ok",
    argsText: "pnpm test",
    argsClamped: false,
    argsLines: 1,
    resultText: "line 1\nline 2\nline 3",
    resultClamped: true,
    resultLines: 40,
  }

  it("offers to open a clamped value, saying exactly how much is hidden", () => {
    const panel = renderPanel()
    initWithTool(panel, clampedTool)
    const node = segNode(panel, "tool-t1")
    expect(node?.querySelector(".tool-result")?.classList.contains("tool-io-clamped")).toBe(true)
    // 40 total, 3 shown → 37 hidden. Arithmetic the user can check.
    expect(node?.querySelector(".tool-io-open")?.textContent).toBe("⤢ open 40 lines (37 more)")
  })

  it("says nothing about opening when nothing is hidden", () => {
    const panel = renderPanel()
    initWithTool(panel, clampedTool)
    const node = segNode(panel, "tool-t1")
    // The input fit — no link, and no truncation mark.
    expect(node?.querySelector(".tool-args")?.classList.contains("tool-io-clamped")).toBe(false)
    expect(node?.querySelectorAll(".tool-io-open")).toHaveLength(1)
  })

  it("posts openToolIo with the segment id and side when the block is clicked", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    initWithTool(panel, clampedTool)
    const node = segNode(panel, "tool-t1")
    // The script posts `ready` on load — only the opens are under test here.
    const opens = (): unknown[] =>
      posted.filter(m => (m as { type?: string }).type === "openToolIo")

    node?.querySelector(".tool-result")?.dispatchEvent(new panel.window.Event("click"))
    expect(opens()).toEqual([{ type: "openToolIo", segmentId: "tool-t1", field: "output" }])

    // The input block is clickable too, even though it was never clamped: a
    // single very long line is clipped by CSS, which the host cannot detect.
    node?.querySelector(".tool-args")?.dispatchEvent(new panel.window.Event("click"))
    expect(opens()[1]).toEqual({ type: "openToolIo", segmentId: "tool-t1", field: "input" })

    // And the explicit link opens the same thing as the block it labels.
    node?.querySelector(".tool-io-open")?.dispatchEvent(new panel.window.Event("click"))
    expect(opens()[2]).toEqual({ type: "openToolIo", segmentId: "tool-t1", field: "output" })
  })

  it("never ships the hidden lines — the DOM holds the preview and nothing else", () => {
    const panel = renderPanel()
    initWithTool(panel, clampedTool)
    // If this ever fails, the clamp has regressed into a CSS trick and the
    // full payload is sitting in the webview.
    expect(segNode(panel, "tool-t1")?.textContent).not.toContain("line 4")
  })
})

describe("transcriptPanel webview — header detail popovers", () => {
  const el = (panel: Panel, id: string): DomElement => {
    const node = panel.document.getElementById(id)
    if (!node) throw new Error(id + " missing from buildHtml output")
    return node
  }

  function initWithUsageAndSession(panel: Panel): void {
    panel.send({
      type: "init",
      session: session({
        adapterSlug: "claude-code",
        model: "sonnet-5",
        auth: { mode: "subscription", fingerprint: "abc" },
        costUsd: 0.03,
        tokensIn: 68694,
        tokensOut: 141,
      }),
      nonce: "n",
      mode: "structured",
      conversation: {
        version: 1,
        sessionId: "s1",
        turns: [],
        usage: { seq: 1, contextUsed: 206_115, contextSize: 1_000_000 },
      },
    })
  }

  it("keeps both popovers closed until their button is clicked", () => {
    const panel = renderPanel()
    initWithUsageAndSession(panel)
    expect(el(panel, "cost-popover").hidden).toBe(true)
    expect(el(panel, "context-popover").hidden).toBe(true)
  })

  it("opens the cost popover with the tokens/model/harness/auth breakdown", () => {
    const panel = renderPanel()
    initWithUsageAndSession(panel)

    el(panel, "cost-btn").dispatchEvent(new panel.window.Event("click"))

    expect(el(panel, "cost-popover").hidden).toBe(false)
    expect(el(panel, "popover-tokens-in").textContent).toBe("68694")
    expect(el(panel, "popover-tokens-out").textContent).toBe("141")
    expect(el(panel, "popover-model").textContent).toBe("sonnet-5")
    expect(el(panel, "popover-harness").textContent).toBe("claude-code")
    expect(el(panel, "popover-auth").textContent).toBe("subscription")
  })

  it("opens the context popover with the raw used/size counts, not just the percent", () => {
    const panel = renderPanel()
    initWithUsageAndSession(panel)

    el(panel, "context-btn").dispatchEvent(new panel.window.Event("click"))

    expect(el(panel, "context-popover").hidden).toBe(false)
    expect(el(panel, "popover-context-used").textContent).toBe("206115")
    expect(el(panel, "popover-context-size").textContent).toBe("1000000")
  })

  it("closes on a second click of the same button", () => {
    const panel = renderPanel()
    initWithUsageAndSession(panel)
    el(panel, "cost-btn").dispatchEvent(new panel.window.Event("click"))
    expect(el(panel, "cost-popover").hidden).toBe(false)

    el(panel, "cost-btn").dispatchEvent(new panel.window.Event("click"))
    expect(el(panel, "cost-popover").hidden).toBe(true)
  })

  it("never shows two popovers at once — opening one closes the other", () => {
    const panel = renderPanel()
    initWithUsageAndSession(panel)
    el(panel, "cost-btn").dispatchEvent(new panel.window.Event("click"))
    expect(el(panel, "cost-popover").hidden).toBe(false)

    el(panel, "context-btn").dispatchEvent(new panel.window.Event("click"))
    expect(el(panel, "context-popover").hidden).toBe(false)
    expect(el(panel, "cost-popover").hidden).toBe(true)
  })

  it("dismisses on Escape", () => {
    const panel = renderPanel()
    initWithUsageAndSession(panel)
    el(panel, "cost-btn").dispatchEvent(new panel.window.Event("click"))
    expect(el(panel, "cost-popover").hidden).toBe(false)

    panel.document.dispatchEvent(new panel.window.KeyboardEvent("keydown", { key: "Escape" }))
    expect(el(panel, "cost-popover").hidden).toBe(true)
  })

  it("dismisses on a click outside", () => {
    const panel = renderPanel()
    initWithUsageAndSession(panel)
    el(panel, "context-btn").dispatchEvent(new panel.window.Event("click"))
    expect(el(panel, "context-popover").hidden).toBe(false)

    panel.document.dispatchEvent(new panel.window.Event("click"))
    expect(el(panel, "context-popover").hidden).toBe(true)
  })
})
