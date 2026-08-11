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
  PresentedPlanSegment,
  PresentedTurn,
  PresentedToolSegment,
  PresentedQuestionSegment,
} from "./conversation.js"
import type { SessionDescriptor } from "../client/types.js"
import type { DomWindow, DomDocument, DomElement, DomEvent } from "jsdom"

interface Panel {
  window: DomWindow
  document: DomDocument
  transcript: DomElement
  book: DomElement
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
  /** Backing store for the webview's persisted state (getState/setState) —
   *  lets a test seed a prior choice and observe what the panel persists. */
  state?: { value: Record<string, unknown> | undefined }
  /** The inline adapter-icon SVG baked into the shipped HTML — mirrors
   *  readAdapterIconSvg's output, empty by default (no icon asset). */
  headerIconSvg?: string
}

function renderPanel(opts: RenderOptions = {}): Panel {
  const html = buildHtml("test-nonce", { xtermJs: "", xtermCss: "", headerIconSvg: opts.headerIconSvg ?? "" })
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://example.test/",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        postMessage: (msg: unknown) => opts.onPost?.(msg),
        getState: () => (opts.state ? opts.state.value : undefined),
        setState: (v: unknown) => {
          if (opts.state) opts.state.value = v as Record<string, unknown>
        },
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
  const book = document.getElementById("book")
  if (!book) throw new Error("book element missing from buildHtml output")
  return {
    window,
    document,
    transcript,
    book,
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

  it("shows a permission ask as awaiting until a permission-resolved patch lands, then as resolved", () => {
    const panel = renderPanel()
    const pendingSeg: PresentedQuestionSegment = {
      kind: "agent-question",
      id: "q1",
      options: ["Allow Once", "Always Allow", "Deny"],
    }
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [{ id: "turn-1", role: "assistant", segments: [pendingSeg] }],
    }
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: conv })

    const before = segNode(panel, "q1")
    expect(before?.textContent).toContain("Awaiting your decision")
    expect(before?.textContent).toContain("Always Allow")

    const resolvedSeg: PresentedQuestionSegment = {
      ...pendingSeg,
      resolved: { decision: "approve", optionId: "allow_always", optionLabel: "Always Allow" },
    }
    const resolvedTurn: PresentedTurn = { id: "turn-1", role: "assistant", segments: [resolvedSeg] }
    panel.send({ type: "patch", upsertTurns: [resolvedTurn], removeTurnIds: [] })

    const after = segNode(panel, "q1")
    expect(after).toBe(before) // same node — patched in place, not replaced
    expect(after?.textContent).not.toContain("Awaiting your decision")
    expect(after?.textContent).toContain("Approved")
    expect(after?.textContent).toContain("Always Allow")
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
    // ...and the header does not repeat them (subtitle is empty for non-PTY sessions).
    expect(panel.document.getElementById("header-subtitle")?.textContent).toBe("")
  })

  it("clicking the model chip posts changeModel to the host", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, { adapterSlug: "claude-code", model: "sonnet-5" })

    btn(panel, "composer-model").dispatchEvent(new panel.window.Event("click"))

    expect(posted).toContainEqual({ type: "changeModel" })
  })

  it("dims the route chip and makes it inert when only one gateway is valid (chip-pickers)", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, {
      adapterSlug: "claude-code",
      model: "sonnet-5",
      route: { gateway: "anthropic" } as SessionDescriptor["route"],
      routeSwitchable: false,
    })
    const route = btn(panel, "composer-route")
    expect(route.textContent).toBe("route: anthropic")
    expect(route.classList.contains("dimmed")).toBe(true)
    route.dispatchEvent(new panel.window.Event("click"))
    expect(posted).not.toContainEqual({ type: "changeRoute" })
  })

  it("keeps the route chip active (clickable) when more than one gateway is valid", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, {
      adapterSlug: "claude-code",
      model: "sonnet-5",
      route: { gateway: "anthropic" } as SessionDescriptor["route"],
      routeSwitchable: true,
    })
    const route = btn(panel, "composer-route")
    expect(route.classList.contains("dimmed")).toBe(false)
    route.dispatchEvent(new panel.window.Event("click"))
    expect(posted).toContainEqual({ type: "changeRoute" })
  })

  it("clicking the posture chip posts changePosture to the host", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, { adapterSlug: "claude-code", model: "sonnet-5", posture: "plan" })

    btn(panel, "composer-posture").dispatchEvent(new panel.window.Event("click"))

    expect(posted).toContainEqual({ type: "changePosture" })
  })

  it("clicking the auth chip posts changeAccess to the host", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, { adapterSlug: "claude-code", model: "sonnet-5" })

    btn(panel, "composer-auth").dispatchEvent(new panel.window.Event("click"))

    expect(posted).toContainEqual({ type: "changeAccess" })
  })

  it("renders visible fallback labels instead of collapsing when model/posture/auth are absent", () => {
    const panel = renderPanel()
    init(panel, { adapterSlug: "claude-code" })
    expect(btn(panel, "composer-model").textContent).toBe("model?")
    expect(btn(panel, "composer-posture").textContent).toBe("default")
    expect(btn(panel, "composer-auth").textContent).toBe("no wallet")
  })

  it("renders the posture and access identity when present", () => {
    const panel = renderPanel()
    init(panel, {
      adapterSlug: "claude-code",
      model: "sonnet-5",
      posture: { harnessModeId: "custom-mode" },
      accessProfile: { profileRef: "work", label: "Work wallet", vendor: "anthropic", method: "oauth-bearer" },
    })
    expect(btn(panel, "composer-posture").textContent).toBe("custom-mode")
    expect(btn(panel, "composer-auth").textContent).toBe("Work wallet")
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

describe("transcriptPanel webview — stop button", () => {
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

  it("shows send, hides stop while idle", () => {
    const panel = renderPanel()
    init(panel, { busy: false })
    expect(btn(panel, "send").hidden).toBe(false)
    expect(btn(panel, "stop").hidden).toBe(true)
  })

  it("swaps to stop the instant the session descriptor goes busy", () => {
    const panel = renderPanel()
    init(panel, { busy: false })

    panel.send({ type: "sessionUpdate", session: session({ busy: true }) })

    expect(btn(panel, "send").hidden).toBe(true)
    expect(btn(panel, "stop").hidden).toBe(false)
  })

  it("hides stop once the session exits mid-turn", () => {
    const panel = renderPanel()
    init(panel, { busy: true })
    expect(btn(panel, "stop").hidden).toBe(false)

    panel.send({ type: "sessionUpdate", session: session({ status: "exited", busy: false }) })

    expect(btn(panel, "stop").hidden).toBe(true)
  })

  it("disables stop the instant it's clicked, until the turn actually settles", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, { busy: true })

    btn(panel, "stop").dispatchEvent(new panel.window.Event("click"))

    expect(posted).toContainEqual({ type: "stop" })
    expect(btn(panel, "stop").disabled).toBe(true)

    // The turn settles — busy flips false — and stop re-arms for next time.
    panel.send({ type: "sessionUpdate", session: session({ busy: false }) })
    expect(btn(panel, "stop").disabled).toBe(false)
  })

  it("re-arms stop on a stopError instead of leaving it stuck disabled", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, { busy: true })

    btn(panel, "stop").dispatchEvent(new panel.window.Event("click"))
    expect(btn(panel, "stop").disabled).toBe(true)

    panel.send({ type: "stopError", title: "Stop failed", message: "boom" })

    expect(btn(panel, "stop").disabled).toBe(false)
    expect(btn(panel, "error-banner").hidden).toBe(false)
    expect(btn(panel, "eb-message").textContent).toBe("boom")
  })
})

describe("transcriptPanel webview — restart button", () => {
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

  it("stays hidden while the session is alive", () => {
    const panel = renderPanel()
    init(panel, { status: "running" })
    expect(btn(panel, "restart-btn").hidden).toBe(true)
  })

  it("appears once the session exits, beside the now-disabled input", () => {
    const panel = renderPanel()
    init(panel, { busy: true })
    expect(btn(panel, "restart-btn").hidden).toBe(true)

    panel.send({ type: "sessionUpdate", session: session({ status: "exited", busy: false }) })

    expect(btn(panel, "restart-btn").hidden).toBe(false)
    // The input stays visible (disabled), not replaced — the last message
    // typed, if any, doesn't vanish.
    expect(btn(panel, "input").disabled).toBe(true)
  })

  it("posts a bare restart message — the host resolves the session id, not the message", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, { status: "killed" })

    btn(panel, "restart-btn").dispatchEvent(new panel.window.Event("click"))

    expect(posted).toContainEqual({ type: "restart" })
  })

  it("hides again for a killed/error session that gets replaced by a fresh running one (same panel reused)", () => {
    const panel = renderPanel()
    init(panel, { status: "error" })
    expect(btn(panel, "restart-btn").hidden).toBe(false)

    panel.send({ type: "sessionUpdate", session: session({ status: "running", busy: false }) })
    expect(btn(panel, "restart-btn").hidden).toBe(true)
  })
})

describe("transcriptPanel webview — resume-chain history", () => {
  function initWithChain(
    panel: Panel,
    resumeChain: NonNullable<Extract<ExtMessage, { type: "init" }>["resumeChain"]>,
  ): void {
    panel.send({
      type: "init",
      session: session({ resumedFrom: "s0", resumeVia: "resumed via ACP" }),
      nonce: "n",
      mode: "structured",
      conversation: { version: 1, sessionId: "s1", turns: [] },
      resumeChain,
    })
  }

  it("stays empty when init carries no resumeChain — a session that wasn't restarted", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session(),
      nonce: "n",
      mode: "structured",
      conversation: { version: 1, sessionId: "s1", turns: [] },
    })
    const history = panel.document.getElementById("resume-history")!
    expect(history.innerHTML).toBe("")
  })

  it("renders the ancestor's turns followed by a divider naming its id and resumeVia", () => {
    const panel = renderPanel()
    const ancestorConversation: PresentedConversation = {
      version: 1,
      sessionId: "s0",
      turns: [
        { id: "turn-1", role: "user", segments: [{ kind: "user", id: "seg-1", html: "ancestor prompt" }] },
        {
          id: "turn-2",
          role: "assistant",
          segments: [{ kind: "assistant-text", id: "seg-2", html: "ancestor reply" }],
        },
      ],
    }
    initWithChain(panel, [
      { sessionId: "s0", resumeVia: "resumed via ACP", conversation: ancestorConversation },
    ])

    const history = panel.document.getElementById("resume-history")!
    // Two turn nodes (user + assistant) plus the divider.
    expect([...history.querySelectorAll(".turn")]).toHaveLength(2)
    expect(history.textContent).toContain("ancestor prompt")
    expect(history.textContent).toContain("ancestor reply")
    const divider = history.querySelector(".resume-divider")
    expect(divider).not.toBeNull()
    expect(divider!.textContent).toContain("s0")
    expect(divider!.textContent).toContain("resumed via ACP")
  })

  it("shows a note (not an error) for an ancestor whose transcript wasn't structured", () => {
    const panel = renderPanel()
    initWithChain(panel, [{ sessionId: "s0", resumeVia: "", unavailable: "no-transcript" }])

    const history = panel.document.getElementById("resume-history")!
    expect(history.querySelector(".resume-unavailable")).not.toBeNull()
    expect(history.textContent).toContain("not available")
    // Still gets a divider — "no continuity" since resumeVia is "".
    expect(history.querySelector(".resume-divider")!.textContent).toContain("no continuity")
  })

  it("renders multiple ancestor segments in the given (oldest-first) order", () => {
    const panel = renderPanel()
    const convFor = (id: string): PresentedConversation => ({
      version: 1,
      sessionId: id,
      turns: [{ id: "turn-1", role: "user", segments: [{ kind: "user", id: "seg-1", html: "from " + id }] }],
    })
    initWithChain(panel, [
      { sessionId: "root", resumeVia: "resumed via claude --resume", conversation: convFor("root") },
      { sessionId: "s0", resumeVia: "resumed via ACP", conversation: convFor("s0") },
    ])

    const history = panel.document.getElementById("resume-history")!
    const dividers = [...history.querySelectorAll(".resume-divider")]
    expect(dividers).toHaveLength(2)
    // "from root" appears before "from s0" in document order.
    expect(history.textContent!.indexOf("from root")).toBeLessThan(history.textContent!.indexOf("from s0"))
    expect(dividers[0]!.textContent).toContain("root")
    expect(dividers[1]!.textContent).toContain("s0")
  })

  it("never touches #resume-history on a later patch — ancestor history is a one-shot static render", () => {
    const panel = renderPanel()
    const ancestorConversation: PresentedConversation = {
      version: 1,
      sessionId: "s0",
      turns: [{ id: "turn-1", role: "user", segments: [{ kind: "user", id: "seg-1", html: "ancestor" }] }],
    }
    initWithChain(panel, [{ sessionId: "s0", resumeVia: "resumed via ACP", conversation: ancestorConversation }])
    const history = panel.document.getElementById("resume-history")!
    const before = history.innerHTML

    panel.send({
      type: "patch",
      upsertTurns: [
        { id: "turn-5", role: "user", segments: [{ kind: "user", id: "seg-5", html: "new live message" }] },
      ],
      removeTurnIds: [],
    })

    expect(history.innerHTML).toBe(before)
    expect(panel.transcript.textContent).toContain("new live message")
  })

  it("#resume-history lives INSIDE #transcript — one continuous scroll region, not a separate pane", () => {
    const panel = renderPanel()
    const ancestorConversation: PresentedConversation = {
      version: 1,
      sessionId: "s0",
      turns: [{ id: "turn-1", role: "user", segments: [{ kind: "user", id: "seg-1", html: "ancestor" }] }],
    }
    initWithChain(panel, [{ sessionId: "s0", resumeVia: "resumed via ACP", conversation: ancestorConversation }])

    // A separate sibling pane wouldn't be found by a query SCOPED to
    // #transcript — this only passes when #resume-history is a descendant.
    expect(panel.transcript.querySelector("#resume-history")).not.toBeNull()
  })

  it("suppresses the empty placeholder (structured mode) when ancestor history exists but the live conversation has no turns yet", () => {
    const panel = renderPanel()
    initWithChain(panel, [{ sessionId: "s0", resumeVia: "resumed via ACP", unavailable: "no-transcript" }])

    // Stitched history is present, but the RESTARTED session (turns: [] in
    // initWithChain) hasn't produced a live turn yet — the "No messages
    // yet." placeholder must not appear underneath it.
    expect(panel.document.getElementById("empty")).toBeNull()
  })

  it("raw mode: suppresses 'No transcript available' when a resumeChain is present but there's no initialHtml yet", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session({ resumedFrom: "s0", resumeVia: "resumed via ACP" }),
      nonce: "n",
      mode: "raw",
      resumeChain: [{ sessionId: "s0", resumeVia: "resumed via ACP", unavailable: "no-transcript" }],
    })

    expect(panel.document.getElementById("empty")).toBeNull()
    expect(panel.transcript.querySelector(".resume-unavailable")).not.toBeNull()
  })

  it("raw mode: still shows 'No transcript available' when there is genuinely nothing (no history, no raw content)", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session(),
      nonce: "n",
      mode: "raw",
    })

    const empty = panel.document.getElementById("empty")
    expect(empty).not.toBeNull()
    expect(empty!.textContent).toContain("No transcript available.")
  })

  it("raw mode: ancestor history renders BEFORE the session's own raw content, in the same region", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session({ resumedFrom: "s0", resumeVia: "resumed via ACP" }),
      nonce: "n",
      mode: "raw",
      initialHtml: '<div class="line">live raw output</div>',
      resumeChain: [
        {
          sessionId: "s0",
          resumeVia: "resumed via ACP",
          conversation: {
            version: 1,
            sessionId: "s0",
            turns: [{ id: "turn-1", role: "user", segments: [{ kind: "user", id: "seg-1", html: "ancestor turn" }] }],
          },
        },
      ],
    })

    expect(panel.document.getElementById("empty")).toBeNull()
    const text = panel.transcript.textContent ?? ""
    expect(text.indexOf("ancestor turn")).toBeLessThan(text.indexOf("live raw output"))
  })
})

describe("transcriptPanel webview — prompt history (↑/↓)", () => {
  const el = (panel: Panel, id: string): DomElement => {
    const node = panel.document.getElementById(id)
    if (!node) throw new Error(id + " missing from buildHtml output")
    return node
  }
  function init(panel: Panel, history: string[] = []): void {
    panel.send({
      type: "init",
      session: session(),
      nonce: "n",
      mode: "structured",
      conversation: { version: 1, sessionId: "s1", turns: [] },
      history,
    })
  }
  function keydown(panel: Panel, key: string): DomEvent {
    const ev = new panel.window.Event("keydown", { cancelable: true })
    ev.key = key
    el(panel, "input").dispatchEvent(ev)
    return ev
  }
  // A real browser collapses the selection to `pos` on both ends; jsdom
  // requires setting selectionStart/selectionEnd independently to reach
  // the same collapsed state (see jsdom.d.ts).
  function setCaret(panel: Panel, pos: number): void {
    const input = el(panel, "input")
    input.selectionStart = pos
    input.selectionEnd = pos
  }

  it("recalls the newest entry on ↑ when the box is empty (caret at 0 for free)", () => {
    const panel = renderPanel()
    init(panel, ["first prompt", "second prompt"])
    setCaret(panel, 0)

    keydown(panel, "ArrowUp")

    expect(el(panel, "input").value).toBe("second prompt")
  })

  it("does NOT recall when the caret is mid-text and navigation hasn't started yet — falls through to normal caret movement", () => {
    const panel = renderPanel()
    init(panel, ["first prompt", "second prompt"])
    const input = el(panel, "input")
    input.value = "typing something"
    setCaret(panel, 5)

    const ev = keydown(panel, "ArrowUp")

    expect(ev.defaultPrevented).toBe(false)
    expect(input.value).toBe("typing something")
  })

  it("REGRESSION: two consecutive ↑ from an empty box step back TWO entries, not one", () => {
    // The caret rule alone (recall only when the caret sits at index 0)
    // combined with parking the caret at the END after a recall meant a
    // second ↑ just re-parked the caret at 0 and did nothing — walking
    // back cost two presses per step. Once navigation is underway, ↑/↓
    // must own the key regardless of where the recall landed the caret.
    const panel = renderPanel()
    init(panel, ["first prompt", "second prompt", "third prompt"])
    const input = el(panel, "input")
    setCaret(panel, 0)

    keydown(panel, "ArrowUp")
    expect(input.value).toBe("third prompt")

    // No caret reset in between — the caret is wherever the first recall
    // parked it (the end of "third prompt"), not back at index 0.
    keydown(panel, "ArrowUp")
    expect(input.value).toBe("second prompt")
  })

  it("walks older on repeated ↑ with no caret reset in between, then back to the draft on ↓", () => {
    const panel = renderPanel()
    init(panel, ["first prompt", "second prompt"])
    const input = el(panel, "input")
    input.value = "unsent draft"
    setCaret(panel, 0)

    keydown(panel, "ArrowUp")
    expect(input.value).toBe("second prompt")
    keydown(panel, "ArrowUp")
    expect(input.value).toBe("first prompt")
    // Oldest entry — one more ↑ does not wrap.
    const ev = keydown(panel, "ArrowUp")
    expect(ev.defaultPrevented).toBe(false)
    expect(input.value).toBe("first prompt")

    // ↓ walks back newer with no caret positioning needed either — it owns
    // the key for the whole navigation, not just from the very end.
    keydown(panel, "ArrowDown")
    expect(input.value).toBe("second prompt")
    keydown(panel, "ArrowDown")
    expect(input.value).toBe("unsent draft")
  })

  it("parks the caret at the end after a recall", () => {
    const panel = renderPanel()
    init(panel, ["first prompt", "a longer second prompt"])
    setCaret(panel, 0)

    keydown(panel, "ArrowUp")

    const input = el(panel, "input")
    expect(input.selectionStart).toBe(input.value!.length)
    expect(input.selectionEnd).toBe(input.value!.length)
  })

  it("typing exits history navigation", () => {
    const panel = renderPanel()
    init(panel, ["first prompt", "second prompt"])
    const input = el(panel, "input")
    setCaret(panel, 0)
    keydown(panel, "ArrowUp")
    expect(input.value).toBe("second prompt")

    // A real keystroke — the escape hatch back out of navigation.
    input.value = "second prompt!"
    input.dispatchEvent(new panel.window.Event("input"))
    setCaret(panel, input.value.length)

    // ↓ is a no-op now: navigation already exited, there is nothing to step to.
    const ev = keydown(panel, "ArrowDown")
    expect(ev.defaultPrevented).toBe(false)
    expect(input.value).toBe("second prompt!")
  })

  it("a click into the textarea exits navigation too, without clearing the history entries", () => {
    const panel = renderPanel()
    init(panel, ["first prompt", "second prompt"])
    const input = el(panel, "input")
    setCaret(panel, 0)
    keydown(panel, "ArrowUp")
    expect(input.value).toBe("second prompt")

    // A real click means "I'm editing this now, not browsing".
    input.dispatchEvent(new panel.window.Event("click"))

    // ↓ is a no-op now: navigation already exited, same as after typing.
    setCaret(panel, input.value!.length)
    const ev = keydown(panel, "ArrowDown")
    expect(ev.defaultPrevented).toBe(false)
    expect(input.value).toBe("second prompt")

    // But the entries themselves survived the click — ↑ from index 0 still
    // recalls, proving only the cursor (not the history) was reset.
    setCaret(panel, 0)
    keydown(panel, "ArrowUp")
    expect(input.value).toBe("second prompt")
  })

  it("the @mention popup still owns ↑/↓ while it is open — history does not steal the key", () => {
    const panel = renderPanel()
    init(panel, ["old prompt"])
    const input = el(panel, "input")
    input.value = "@men"
    setCaret(panel, input.value.length)
    input.dispatchEvent(new panel.window.Event("input"))
    panel.send({
      type: "mentionCandidates",
      query: "men",
      items: [
        { path: "/repo/src/webview/mentions.logic.ts", label: "src/webview/mentions.logic.ts" },
        { path: "/repo/src/webview/mentionSource.ts", label: "src/webview/mentionSource.ts" },
      ],
    })

    keydown(panel, "ArrowUp")

    // The popup consumed the key to move its own highlight — the textarea
    // still holds the in-progress @token, not a recalled history entry.
    expect(el(panel, "mention-popup").hidden).toBe(false)
    expect(input.value).toBe("@men")
  })

  it("a just-sent prompt is recallable on the very next ↑", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, [])
    const input = el(panel, "input")
    input.value = "brand new message"
    setCaret(panel, input.value.length)
    input.dispatchEvent(new panel.window.Event("input"))

    el(panel, "send").dispatchEvent(new panel.window.Event("click"))
    expect(posted).toContainEqual({ type: "send", text: "brand new message" })

    setCaret(panel, 0)
    keydown(panel, "ArrowUp")

    expect(input.value).toBe("brand new message")
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

  it("falls back to the friendly adapter · short-id name when neither label nor title exist yet (FIX D) — pre-#390 sessions self-heal on their next prompt", () => {
    const panel = renderPanel()
    init(panel, { label: undefined, title: undefined, id: "sess_09ed741a" })
    // No bare sess_… id: the header now mirrors sessionDisplayName's fallback.
    expect(el(panel, "header-title").textContent).toBe("agent-cli · ed741a")
  })

  it("click-to-edit posts a rename with the typed name, prefilled with the current name (FIX B)", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, { label: "old name", title: undefined })
    const header = el(panel, "header-title")
    header.dispatchEvent(new panel.window.Event("click"))
    const input = header.querySelector("input")
    expect(input).not.toBeNull()
    // Prefilled with the editable name (label), NOT the adapter·id fallback.
    expect(input?.value).toBe("old name")
    input!.value = "renamed"
    input!.dispatchEvent(new panel.window.KeyboardEvent("keydown", { key: "Enter" }))
    expect(posted).toContainEqual({ type: "rename", name: "renamed" })
  })

  it("Escape cancels the rename without posting and restores the title", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel, { label: "old name", title: undefined })
    const header = el(panel, "header-title")
    header.dispatchEvent(new panel.window.Event("click"))
    const input = header.querySelector("input")
    input!.value = "discard me"
    input!.dispatchEvent(new panel.window.KeyboardEvent("keydown", { key: "Escape" }))
    expect(posted.some(m => (m as { type: string }).type === "rename")).toBe(false)
    expect(el(panel, "header-title").textContent).toBe("old name")
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

  it("renders the context percent as a compact ring gauge, keeping the raw counts for the popover", () => {
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
    // The percent moved off the button text and into the gauge's #ctx-pct
    // label; the ring itself carries the fill visually (FIX 5). in/out dropped:
    // they repeated the cost button in the same header.
    expect(el(panel, "ctx-pct").textContent).toBe("21%")
    expect(el(panel, "context-btn").hidden).toBe(false)
    // 21% is a calm fill — the arc stays grey (below warnAtPct).
    expect(el(panel, "ctx-arc").classList.contains("amber")).toBe(false)
    expect(el(panel, "ctx-arc").classList.contains("red")).toBe(false)
  })

  it("colours the gauge arc as the context fills toward the ceiling", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session(),
      nonce: "n",
      mode: "structured",
      conversation: { version: 1, sessionId: "s1", turns: [], usage: { seq: 1, contextUsed: 95, contextSize: 100 } },
    })
    expect(el(panel, "ctx-pct").textContent).toBe("95%")
    // Past compactAtPct (default 90) — the ring goes red.
    expect(el(panel, "ctx-arc").classList.contains("red")).toBe(true)
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
    // A gauge with nothing to show is worse than a button that isn't there.
    expect(el(panel, "context-btn").hidden).toBe(true)
  })

  it("keeps the working row hidden in book view — the live chapter carries 'Working…' there instead", () => {
    const panel = renderPanel()
    init(panel, { status: "running", busy: true, tokensOut: 983 })
    // Book view is the default; its live chapter already narrates the in-flight
    // turn, so the separate row stays hidden to avoid a doubled "Working…".
    expect(el(panel, "working").hidden).toBe(true)
  })

  it("shows the working row with a ticking elapsed only while busy — in the raw transcript", () => {
    vi.useFakeTimers()
    const panel = renderPanel({ fakeTimers: true })
    init(panel, { status: "running", busy: true, tokensOut: 983 })
    // The row lives in the raw transcript, where nothing else narrates the turn.
    // The segmented control delegates clicks, so the event must bubble.
    el(panel, "view-toggle").querySelector('[data-view="transcript"]')!.dispatchEvent(new panel.window.Event("click", { bubbles: true }))

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
    // The note text lives in its own span since the dismissable-✕ split —
    // asserting the container would drag the button's glyph into the string.
    expect(el(panel, "blocked-note-text").textContent).toBe("blocked on command · toolu_01")
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
    expect(el(panel, "blocked-note-text").textContent).toBe("")
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

  it("names the harness, model, posture, and auth identity in the composer bar", () => {
    const panel = renderPanel()
    init(panel, {
      adapterSlug: "claude-code",
      model: "sonnet-5",
      posture: "plan",
      auth: { mode: "subscription", fingerprint: "abc" },
    })
    expect(el(panel, "composer-harness").textContent).toBe("claude-code")
    expect(el(panel, "composer-model").textContent).toBe("sonnet-5")
    expect(el(panel, "composer-posture").textContent).toBe("plan")
    // No named access profile echoed, so this falls back to the raw auth mode.
    expect(el(panel, "composer-auth").textContent).toBe("subscription")
  })

  it("wears the harness glyph in the header title, tooltipped with the adapter name", () => {
    const panel = renderPanel()
    init(panel, { adapterSlug: "claude-code" })
    expect(el(panel, "header-icon").textContent).toBe("❋")
    expect(el(panel, "header-icon").title).toBe("claude-code")
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
    // Two decimals on the pill face; full precision moves to the hover title.
    expect(el(panel, "cost-btn").textContent).toBe("$0.03")
    expect(el(panel, "cost-btn").title).toBe("$0.0300")
    expect(el(panel, "cost-btn").textContent).not.toContain("in ")
  })

  it("paints the title status dot from the visibility state (#conversation-chrome)", () => {
    const panel = renderPanel()
    init(panel, { status: "running", busy: true })
    expect(el(panel, "title-status").className).toContain("busy")
    panel.send({ type: "sessionUpdate", session: session({ status: "running", busy: false, awaitingInput: true }) })
    expect(el(panel, "title-status").className).toContain("awaiting")
    panel.send({ type: "sessionUpdate", session: session({ status: "running", busy: false }) })
    expect(el(panel, "title-status").className).toContain("quiet")
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
    expect(el(panel, "ctx-pct").textContent).toBe("6%")
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

  it("turns an uploaded path into a removable chip (basename label, full path in the title), not raw text", () => {
    const panel = renderPanel()
    init(panel)
    const input = el(panel, "input")
    input.value = "look at"

    panel.send({ type: "attachmentUploaded", path: "/home/.agentproto/.agentproto-attachments/paste.png" })

    // The typed prose is untouched — the attachment rides as a chip, not text.
    expect(input.value).toBe("look at")
    const chips = [...el(panel, "composer-attachments").querySelectorAll(".attach-chip")]
    expect(chips).toHaveLength(1)
    expect(chips[0]?.querySelector(".attach-chip-label")?.textContent).toBe("paste.png")
    expect(chips[0]?.title).toBe("/home/.agentproto/.agentproto-attachments/paste.png")
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

describe("transcriptPanel webview — attachment chips → prompt", () => {
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
  const chips = (panel: Panel): DomElement[] => [...el(panel, "composer-attachments").querySelectorAll(".attach-chip")]

  it("appends the chip path to the typed prose in the sent prompt, then clears the chips", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel)
    const input = el(panel, "input")
    input.value = "what is this"
    input.dispatchEvent(new panel.window.Event("input"))
    panel.send({ type: "attachmentUploaded", path: "/ap/.agentproto-attachments/a.png" })

    el(panel, "send").dispatchEvent(new panel.window.Event("click"))

    expect(posted).toContainEqual({ type: "send", text: "what is this /ap/.agentproto-attachments/a.png" })
    expect(chips(panel)).toHaveLength(0) // cleared after send
    expect(input.value).toBe("")
  })

  it("lets you send an attachment with no typed words at all", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel)
    // no text — send is inert until the chip arrives
    expect(el(panel, "send").disabled).toBe(true)
    panel.send({ type: "attachmentUploaded", path: "/ap/.agentproto-attachments/a.png" })
    expect(el(panel, "send").disabled).toBe(false)

    el(panel, "send").dispatchEvent(new panel.window.Event("click"))
    expect(posted).toContainEqual({ type: "send", text: "/ap/.agentproto-attachments/a.png" })
  })

  it("removes a chip when its ✕ is clicked", () => {
    const panel = renderPanel()
    init(panel)
    panel.send({ type: "attachmentUploaded", path: "/ap/x/a.png" })
    panel.send({ type: "attachmentUploaded", path: "/ap/x/b.png" })
    expect(chips(panel)).toHaveLength(2)

    chips(panel)[0]?.querySelector(".attach-chip-remove")?.dispatchEvent(new panel.window.Event("click"))

    const labels = chips(panel).map(c => c.querySelector(".attach-chip-label")?.textContent)
    expect(labels).toEqual(["b.png"])
  })

  it("de-dupes the same path and caps the count at 10, refusing the 11th with a message", () => {
    const panel = renderPanel()
    init(panel)
    // same path twice → one chip
    panel.send({ type: "attachmentUploaded", path: "/ap/x/dup.png" })
    panel.send({ type: "attachmentUploaded", path: "/ap/x/dup.png" })
    expect(chips(panel)).toHaveLength(1)

    for (let i = 0; i < 10; i++) panel.send({ type: "attachmentUploaded", path: `/ap/x/f${i}.png` })
    // 1 dup + 9 more fit (total 10); the 10th extra is the 11th overall → refused
    expect(chips(panel).length).toBe(10)
    expect(el(panel, "error-banner").hidden).toBe(false)
    expect(el(panel, "eb-title").textContent).toBe("Too many attachments")
  })
})

describe("transcriptPanel webview — drag and drop", () => {
  const el = (panel: Panel, id: string): DomElement => {
    const node = panel.document.getElementById(id)
    if (!node) throw new Error(id + " missing from buildHtml output")
    return node
  }
  function init(panel: Panel): void {
    panel.send({
      type: "init",
      session: session(),
      nonce: "n",
      mode: "structured",
      conversation: { version: 1, sessionId: "s1", turns: [] },
    })
  }
  function dropEvent(panel: Panel, opts: { uriList?: string; files?: unknown[] }): DomEvent {
    const ev = new panel.window.Event("drop", { cancelable: true })
    ev.dataTransfer = {
      getData: (type: string) => (type.includes("uri-list") ? opts.uriList ?? "" : ""),
      files: opts.files ?? [],
      dropEffect: "",
    }
    return ev
  }
  const flush = async (): Promise<void> => {
    await new Promise(res => setTimeout(res, 0))
    await new Promise(res => setTimeout(res, 0))
  }
  const chips = (panel: Panel): DomElement[] => [...el(panel, "composer-attachments").querySelectorAll(".attach-chip")]

  it("attaches a file dragged from the VS Code Explorer BY PATH — no upload (A1)", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel)

    el(panel, "composer").dispatchEvent(dropEvent(panel, { uriList: "file:///work/repo/src/x.ts" }))

    // A ready path becomes a chip directly; nothing was uploaded.
    expect(posted.filter(m => (m as { type?: string }).type === "attachFile")).toEqual([])
    expect(chips(panel).map(c => c.querySelector(".attach-chip-label")?.textContent)).toEqual(["x.ts"])
  })

  it("uploads a file dragged from the OS (raw bytes, carries its own name)", async () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel)
    const file = new panel.window.File([new Uint8Array([1, 2, 3])], "report.pdf", { type: "application/pdf" })

    el(panel, "composer").dispatchEvent(dropEvent(panel, { files: [file] }))
    await flush()

    const attach = posted.filter(m => (m as { type?: string }).type === "attachFile") as Array<{
      name: string
      mime: string
      bytes: { byteLength: number }
    }>
    expect(attach).toHaveLength(1)
    expect(attach[0]!.name).toBe("report.pdf")
    expect(attach[0]!.mime).toBe("application/pdf")
    expect(attach[0]!.bytes.byteLength).toBe(3)
  })
})

describe("transcriptPanel webview — @file mentions", () => {
  const el = (panel: Panel, id: string): DomElement => {
    const node = panel.document.getElementById(id)
    if (!node) throw new Error(id + " missing from buildHtml output")
    return node
  }
  function init(panel: Panel): void {
    panel.send({
      type: "init",
      session: session(),
      nonce: "n",
      mode: "structured",
      conversation: { version: 1, sessionId: "s1", turns: [] },
    })
  }
  function type(panel: Panel, text: string): void {
    const input = el(panel, "input")
    input.value = text
    input.selectionStart = text.length
    input.dispatchEvent(new panel.window.Event("input"))
  }
  function keydown(panel: Panel, key: string): DomEvent {
    const ev = new panel.window.Event("keydown", { cancelable: true })
    ev.key = key
    el(panel, "input").dispatchEvent(ev)
    return ev
  }
  const items = (panel: Panel): DomElement[] => [...el(panel, "mention-popup").querySelectorAll(".mention-item")]

  it("asks the host for candidates when an @ token is typed", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel)

    type(panel, "see @src/we")

    expect(posted).toContainEqual({ type: "requestMentions", query: "src/we" })
  })

  it("renders the candidate list and inserts the chosen path as a chip on Enter", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel)
    type(panel, "@men")
    panel.send({
      type: "mentionCandidates",
      query: "men",
      items: [
        { path: "/repo/src/webview/mentions.logic.ts", label: "src/webview/mentions.logic.ts" },
        { path: "/repo/src/webview/mentionSource.ts", label: "src/webview/mentionSource.ts" },
      ],
    })
    expect(items(panel)).toHaveLength(2)

    keydown(panel, "ArrowDown") // move to 2nd
    keydown(panel, "Enter") // choose it

    const chips = [...el(panel, "composer-attachments").querySelectorAll(".attach-chip")]
    expect(chips.map(c => c.querySelector(".attach-chip-label")?.textContent)).toEqual(["mentionSource.ts"])
    expect(el(panel, "mention-popup").hidden).toBe(true)
    // The @token was consumed out of the textarea.
    expect(el(panel, "input").value).toBe("")
  })

  it("ignores a stale candidate response for a query the user has moved past", () => {
    const panel = renderPanel()
    init(panel)
    type(panel, "@zzz")
    // A response for an OLDER query must not paint over the current one.
    panel.send({ type: "mentionCandidates", query: "old", items: [{ path: "/x/a.ts", label: "a.ts" }] })
    expect(el(panel, "mention-popup").querySelector(".mention-item")).toBeNull()
  })

  it("closes the popup on Escape without sending", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    init(panel)
    type(panel, "@a")
    panel.send({ type: "mentionCandidates", query: "a", items: [{ path: "/x/a.ts", label: "a.ts" }] })

    keydown(panel, "Escape")

    expect(el(panel, "mention-popup").hidden).toBe(true)
    expect(posted.filter(m => (m as { type?: string }).type === "send")).toEqual([])
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

  it("opens the cost popover with the tokens/model/harness/access breakdown", () => {
    const panel = renderPanel()
    initWithUsageAndSession(panel)

    el(panel, "cost-btn").dispatchEvent(new panel.window.Event("click"))

    expect(el(panel, "cost-popover").hidden).toBe(false)
    expect(el(panel, "popover-tokens-in").textContent).toBe("68694")
    expect(el(panel, "popover-tokens-out").textContent).toBe("141")
    expect(el(panel, "popover-model").textContent).toBe("sonnet-5")
    expect(el(panel, "popover-harness").textContent).toBe("claude-code")
    // No named profile echoed → the access row falls back to the auth method.
    expect(el(panel, "popover-auth").textContent).toBe("subscription")
  })

  it("names the bound wallet profile in the access row when one is echoed (FIX 3)", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session({
        auth: { mode: "subscription", fingerprint: "abc" },
        accessProfile: { profileRef: "work", label: "Work wallet", vendor: "anthropic", method: "oauth-bearer" },
      }),
      nonce: "n",
      mode: "structured",
      conversation: { version: 1, sessionId: "s1", turns: [] },
    })

    el(panel, "cost-btn").dispatchEvent(new panel.window.Event("click"))
    // The named identity wins over the raw auth method — the wallet, never a secret.
    expect(el(panel, "popover-auth").textContent).toBe("Work wallet")
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

describe("header terminal button", () => {
  function el(panel: Panel, id: string): DomElement {
    const found = panel.document.getElementById(id)
    if (!found) throw new Error(`missing #${id}`)
    return found
  }

  it("is shown for agent-cli sessions and posts restartAsTerminal on click", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: msg => posted.push(msg) })
    panel.send({
      type: "init",
      session: session({ kind: "agent-cli" }),
      nonce: "n",
      mode: "structured",
      canToggle: true,
    })

    // The webview posts `ready` on init; clear it so the assertion below only
    // sees the button click.
    posted.length = 0

    const btn = el(panel, "open-terminal-btn")
    expect(btn.hidden).toBe(false)

    btn.dispatchEvent(new panel.window.Event("click"))
    expect(posted).toEqual([{ type: "restartAsTerminal" }])
  })

  it("is shown for plain PTY sessions and posts openTerminal on click", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: msg => posted.push(msg) })
    panel.send({
      type: "init",
      session: session({ kind: "terminal", pty: true }),
      nonce: "n",
      mode: "pty",
    })

    posted.length = 0

    const btn = el(panel, "open-terminal-btn")
    expect(btn.hidden).toBe(false)

    btn.dispatchEvent(new panel.window.Event("click"))
    expect(posted).toEqual([{ type: "openTerminal" }])
  })
})

describe("transcriptPanel webview — PTY mode", () => {
  function el(panel: Panel, id: string): DomElement {
    const found = panel.document.getElementById(id)
    if (!found) throw new Error(`missing #${id}`)
    return found
  }

  it("hides the transcript and composer and shows the PTY view", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session({ kind: "terminal", pty: true, pid: 42, argv: ["bash"], cwd: "/home" }),
      nonce: "n",
      mode: "pty",
    })

    expect(el(panel, "transcript").hidden).toBe(true)
    expect(el(panel, "composer").hidden).toBe(true)
    expect(el(panel, "pty-view").classList.contains("active")).toBe(true)
  })

  it("shows pid and argv as the header subtitle with cwd as tooltip", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session({ kind: "terminal", pty: true, pid: 42, argv: ["bash", "-l"], cwd: "/home" }),
      nonce: "n",
      mode: "pty",
    })

    const subtitle = el(panel, "header-subtitle")
    expect(subtitle.textContent).toBe("42 · bash -l")
    expect(subtitle.title).toBe("/home")
  })

  it("hides the model/posture/auth chips for a plain PTY session", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session({ kind: "terminal", pty: true, adapterSlug: "claude-code" }),
      nonce: "n",
      mode: "pty",
    })

    expect(el(panel, "composer-harness").hidden).toBe(true)
    expect(el(panel, "composer-model").hidden).toBe(true)
    expect(el(panel, "composer-posture").hidden).toBe(true)
    expect(el(panel, "composer-auth").hidden).toBe(true)
  })

  it("renders a reconnect banner on ptyStatus reconnecting", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session({ kind: "terminal", pty: true }),
      nonce: "n",
      mode: "pty",
    })

    panel.send({ type: "ptyStatus", status: "reconnecting", attempt: 1, max: 5, delayMs: 1000 })

    const ptyView = el(panel, "pty-view")
    expect(ptyView.textContent).toContain("reconnecting")
  })

  it("renders an exit banner on ptyExit and disables further input", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session({ kind: "terminal", pty: true }),
      nonce: "n",
      mode: "pty",
    })

    panel.send({ type: "ptyExit", exitCode: 0, signal: 9 })

    const ptyView = el(panel, "pty-view")
    expect(ptyView.textContent).toContain("exited")
  })
})

describe("transcriptPanel webview — book view", () => {
  const el = (panel: Panel, id: string): DomElement => {
    const node = panel.document.getElementById(id)
    if (!node) throw new Error("missing #" + id)
    return node
  }
  const chapters = (panel: Panel): DomElement[] => [...panel.book.querySelectorAll(".chapter")]

  // One user prompt + its answering assistant turn = one chapter.
  function askConv(): PresentedConversation {
    return {
      version: 1,
      sessionId: "s1",
      turns: [
        { id: "turn-1", role: "user", segments: [{ kind: "user", id: "u1", html: "Fix the boot" }], startedAt: "2026-01-01T00:00:00Z" },
        {
          id: "turn-2",
          role: "assistant",
          segments: [{ kind: "assistant-text", id: "a1", html: "<p>The shell was lying. More detail.</p>" }],
          startedAt: "2026-01-01T00:00:05Z",
        },
      ],
    }
  }

  // An assistant turn with ONE pending tool that opened `ms` before "now".
  function staleToolConv(ms: number): PresentedConversation {
    return {
      version: 1,
      sessionId: "s1",
      turns: [
        {
          id: "turn-2",
          role: "assistant",
          segments: [{ kind: "tool", id: "t1", toolName: "read", isError: false, status: "pending", ts: new Date(Date.now() - ms).toISOString() }],
        },
      ],
    }
  }

  it("defaults to the book view for a structured session — book shown, transcript hidden, Book segment active", () => {
    const panel = renderPanel()
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: askConv() })

    expect(panel.book.hidden).toBe(false)
    expect(panel.transcript.hidden).toBe(true)
    const toggle = el(panel, "view-toggle")
    expect(toggle.hidden).toBe(false)
    // Segmented control shows WHERE YOU ARE: the Book segment is active.
    expect(toggle.querySelector('[data-view="book"]')!.classList.contains("on")).toBe(true)
    expect(toggle.querySelector('[data-view="transcript"]')!.classList.contains("on")).toBe(false)
    // The composer placeholder switches to the book's invitation.
    expect((el(panel, "input") as unknown as { placeholder: string }).placeholder).toContain("opens the next chapter")
  })

  it("shows a session-identity hero (not 'No messages yet') for a blank conversation", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session({
        adapterSlug: "claude-code",
        model: "claude-opus-4-8",
        accessProfile: { profileRef: "p1", label: "Claude Subs Agentik", vendor: "anthropic", method: "oauth-bearer" },
      }),
      nonce: "n",
      mode: "structured",
      conversation: { version: 1, sessionId: "s1", turns: [] },
    })
    const hero = panel.book.querySelector(".book-hero")
    expect(hero).not.toBeNull()
    expect(panel.book.querySelector("#book-empty")).toBeNull()
    const text = hero!.textContent ?? ""
    expect(text).not.toContain("No messages yet")
    // The facts a fresh tab needs: who answers, on which model, on whose dime.
    expect(text).toContain("claude-code")
    expect(text).toContain("claude-opus-4-8")
    expect(text).toContain("Claude Subs Agentik")
  })

  it("removes the hero once the first real turns arrive — 'Ready when you are' must not outlive the blank state", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session(),
      nonce: "n",
      mode: "structured",
      conversation: { version: 1, sessionId: "s1", turns: [] },
    })
    expect(panel.book.querySelector(".book-hero")).not.toBeNull()

    panel.send({ type: "patch", upsertTurns: askConv().turns, removeTurnIds: [] })
    expect(chapters(panel)).toHaveLength(1)
    expect(panel.book.querySelector(".book-hero")).toBeNull()
  })

  it("hides the book and its toggle for a raw (non-structured) session", () => {
    const panel = renderPanel()
    panel.send({ type: "init", session: session(), nonce: "n", mode: "raw", initialHtml: "<div>raw</div>" })
    expect(panel.book.hidden).toBe(true)
    expect(el(panel, "view-toggle").hidden).toBe(true)
  })

  it("renders a user-opened chapter with an ask card, origin mark, narration, and a serif title", () => {
    const panel = renderPanel()
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: askConv() })

    const ch = chapters(panel)
    expect(ch).toHaveLength(1)
    expect(ch[0]!.dataset.chapterId).toBe("turn-1")
    // Title = first narration sentence, trailing period dropped.
    expect(ch[0]!.querySelector(".fold h2")?.textContent).toBe("The shell was lying")
    expect(ch[0]!.querySelector(".fold .who")?.textContent).toBe("◈ you")
    expect(ch[0]!.querySelector(".ask .atext")?.textContent).toContain("Fix the boot")
    expect(ch[0]!.querySelector(".narration .story")?.textContent).toContain("The shell was lying")
  })

  it("attributes a supervisor-injected ask (promptSource agent:<id>) — SUPERVISOR ASKED label + supervisor origin mark", () => {
    const panel = renderPanel()
    const conv = askConv()
    conv.turns[0]! = { ...conv.turns[0]!, promptSource: "agent:sess_boss1" }
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: conv })

    const ch = chapters(panel)[0]!
    expect(ch.querySelector(".fold .who")?.textContent).toBe("◈ supervisor")
    const alabel = ch.querySelector(".ask .alabel")
    expect(alabel?.textContent).toBe("SUPERVISOR ASKED")
    // The injecting session's id stays reachable (hover title), not lost.
    expect(alabel?.getAttribute("title")).toBe("sess_boss1")
  })

  it("preserves markdown block structure (line breaks, lists, code fences) in narration", () => {
    const panel = renderPanel()
    // The html the host ships is renderMarkdown output — real <p>/<br>/<ul>/<pre>.
    // The book must inject it intact, not flatten it into a run-on paragraph.
    const md = "<p>Line A<br>Line B</p>\n<ul><li>one</li><li>two</li></ul>\n<pre><code>x=1\ny=2</code></pre>"
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [
        { id: "turn-1", role: "user", segments: [{ kind: "user", id: "u1", html: "Do it" }] },
        { id: "turn-2", role: "assistant", segments: [{ kind: "assistant-text", id: "a1", html: md }] },
      ],
    }
    panel.send({ type: "init", session: session({ busy: false }), nonce: "n", mode: "structured", conversation: conv })

    const story = chapters(panel)[0]!.querySelector(".narration .story")
    expect(story?.querySelector("br")).not.toBeNull() // single newline honoured
    expect(story?.querySelectorAll("ul li")).toHaveLength(2) // list not collapsed
    expect(story?.querySelector("pre code")?.textContent).toBe("x=1\ny=2") // fence intact
  })

  it("wraps wide narration blocks (table, code) with a pop-out that opens them in an editor", () => {
    const posted: unknown[] = []
    const panel = renderPanel({ onPost: m => posted.push(m) })
    const md =
      "<p>Here:</p>\n" +
      "<table><thead><tr><th>Col</th></tr></thead><tbody><tr><td>Val</td></tr></tbody></table>\n" +
      "<pre><code>const x = 1</code></pre>"
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [
        { id: "turn-1", role: "user", segments: [{ kind: "user", id: "u1", html: "go" }] },
        { id: "turn-2", role: "assistant", segments: [{ kind: "assistant-text", id: "a1", html: md }] },
      ],
    }
    panel.send({ type: "init", session: session({ busy: false }), nonce: "n", mode: "structured", conversation: conv })

    const story = chapters(panel)[0]!.querySelector(".narration .story")
    const blocks = [...(story?.querySelectorAll(".book-block") ?? [])]
    expect(blocks).toHaveLength(2) // both the table and the code fence are wrapped
    expect([...(story?.querySelectorAll(".block-popout") ?? [])]).toHaveLength(2)

    // Clicking the table's pop-out posts openBlock with tab-separated cell text.
    const tableWrap = blocks.find(b => b.querySelector("table"))
    tableWrap?.querySelector(".block-popout")?.dispatchEvent(new panel.window.Event("click"))
    const msg = posted.find(m => (m as { type?: string }).type === "openBlock") as
      | { text: string; name: string }
      | undefined
    expect(msg).toBeTruthy()
    expect(msg?.text).toContain("Col")
    expect(msg?.text).toContain("Val")
  })

  it("pins the ask as its own block above the fold — not inside the foldable body, and never as the title", () => {
    const panel = renderPanel()
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [
        { id: "turn-1", role: "user", segments: [{ kind: "user", id: "u1", html: "Please fix the boot sequence now" }] },
        { id: "turn-2", role: "assistant", segments: [{ kind: "assistant-text", id: "a1", html: "The shell was lying." }] },
        { id: "turn-3", role: "user", segments: [{ kind: "user", id: "u2", html: "Second ask" }] },
        { id: "turn-4", role: "assistant", segments: [{ kind: "assistant-text", id: "a2", html: "Removed the dead servers." }] },
      ],
    }
    panel.send({ type: "init", session: session({ busy: false }), nonce: "n", mode: "structured", conversation: conv })

    const first = chapters(panel)[0]!
    // The ask is a direct child of the chapter, ABOVE the fold — never in .cbody.
    const ask = first.querySelector(":scope > .ask")
    expect(ask).not.toBeNull()
    expect(first.querySelector(":scope > .cbody .ask")).toBeNull()
    const kids = [...first.querySelectorAll(":scope > *")].map(n => n.className)
    expect(kids.indexOf("ask")).toBeLessThan(kids.indexOf("fold"))
    // The past chapter is folded, yet its ask block stays displayed (pinned).
    expect(first.className).not.toContain("openc")
    expect((ask as DomElement).hidden).toBe(false)
    // The fold title is the agent's narration — NOT the user's words.
    const title = first.querySelector(".fold h2")?.textContent
    expect(title).toBe("The shell was lying")
    expect(title).not.toContain("fix the boot sequence")
  })

  it("folds past chapters and keeps the newest open; a fold click toggles a past chapter", () => {
    const panel = renderPanel()
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [
        { id: "turn-1", role: "user", segments: [{ kind: "user", id: "u1", html: "First" }] },
        { id: "turn-2", role: "assistant", segments: [{ kind: "assistant-text", id: "a1", html: "First answer." }] },
        { id: "turn-3", role: "user", segments: [{ kind: "user", id: "u2", html: "Second" }] },
        { id: "turn-4", role: "assistant", segments: [{ kind: "assistant-text", id: "a2", html: "Second answer." }] },
      ],
    }
    panel.send({ type: "init", session: session({ busy: false }), nonce: "n", mode: "structured", conversation: conv })

    const ch = chapters(panel)
    expect(ch).toHaveLength(2)
    expect(ch[0]!.className).not.toContain("openc") // past chapter folded
    expect(ch[1]!.className).toContain("openc") // newest open
    const fold = ch[0]!.querySelector(".fold") as DomElement
    fold.dispatchEvent(new panel.window.Event("click"))
    expect(ch[0]!.className).toContain("openc")
    expect(fold.getAttribute("aria-expanded")).toBe("true")
    fold.dispatchEvent(new panel.window.Event("click"))
    expect(ch[0]!.className).not.toContain("openc")
  })

  it("aggregates working steps behind a '$ show N steps' drawer that expands on click", () => {
    const panel = renderPanel()
    const activity: PresentedActivitySegment = {
      kind: "activity",
      id: "act-1",
      children: [
        { kind: "tool", id: "t1", toolName: "bash", isError: false, status: "ok" },
        { kind: "tool", id: "t2", toolName: "read", isError: true, status: "error" },
      ],
      summary: "2 steps · 1 failed",
      count: 2,
      status: "ok",
    }
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [
        { id: "turn-1", role: "user", segments: [{ kind: "user", id: "u1", html: "go" }] },
        { id: "turn-2", role: "assistant", segments: [{ kind: "assistant-text", id: "a1", html: "Did it." }, activity] },
      ],
    }
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: conv })

    const ch = chapters(panel)[0]!
    const details = ch.querySelector(".chapter-steps .details") as DomElement
    expect(details.textContent).toBe("show 2 steps · 1 failed")
    const stepsBody = ch.querySelector(".chapter-steps .steps-body") as DomElement
    expect(stepsBody.hidden).toBe(true)
    details.dispatchEvent(new panel.window.Event("click"))
    expect(stepsBody.hidden).toBe(false)
    // The reused segment renderer built the activity card.
    expect(stepsBody.querySelector("[data-seg-id='act-1']")).not.toBeNull()
  })

  it("switches to the transcript escape hatch and persists the choice", () => {
    const state = { value: undefined as Record<string, unknown> | undefined }
    const panel = renderPanel({ state })
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: askConv() })

    const toggle = el(panel, "view-toggle")
    toggle.querySelector('[data-view="transcript"]')!.dispatchEvent(new panel.window.Event("click", { bubbles: true }))
    expect(panel.book.hidden).toBe(true)
    expect(panel.transcript.hidden).toBe(false)
    expect(toggle.querySelector('[data-view="transcript"]')!.classList.contains("on")).toBe(true)
    expect(state.value?.bookView).toBe(false)
  })

  it("honors a persisted transcript-view choice on init", () => {
    const state = { value: { bookView: false } as Record<string, unknown> | undefined }
    const panel = renderPanel({ state })
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: askConv() })
    expect(panel.book.hidden).toBe(true)
    expect(panel.transcript.hidden).toBe(false)
    expect(el(panel, "view-toggle").querySelector('[data-view="transcript"]')!.classList.contains("on")).toBe(true)
  })

  it("renders the pause card with the agent's question when the session is awaiting input", () => {
    const panel = renderPanel()
    panel.send({
      type: "init",
      session: session({ awaitingInput: true }),
      nonce: "n",
      mode: "structured",
      conversation: askConv(),
    })
    const pause = panel.book.querySelector(".pause")
    expect(pause).not.toBeNull()
    expect(pause?.querySelector(".pquestion")?.textContent).toContain("More detail")
    // The composer is focused so the user can answer immediately.
    expect(panel.document.activeElement).toBe(el(panel, "input"))
  })

  it("does NOT render the pause card while the agent is actively working, even if awaitingInput lingers", () => {
    const panel = renderPanel()
    // A stale awaitingInput racing with a resumed turn (busy=true) must not
    // flash the 'PAUSED TO ASK' card during active work.
    panel.send({
      type: "init",
      session: session({ awaitingInput: true, busy: true }),
      nonce: "n",
      mode: "structured",
      conversation: askConv(),
    })
    expect(panel.book.querySelector(".pause")).toBeNull()
  })

  it("marks the newest chapter live with a blinking cursor and a '$ now:' line while busy", () => {
    const panel = renderPanel()
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [
        { id: "turn-1", role: "user", segments: [{ kind: "user", id: "u1", html: "go" }] },
        {
          id: "turn-2",
          role: "assistant",
          segments: [
            { kind: "assistant-text", id: "a1", html: "Working on it." },
            { kind: "tool", id: "t1", toolName: "bash", isError: false, status: "pending", ts: new Date(Date.now() - 3000).toISOString() },
          ],
        },
      ],
    }
    panel.send({ type: "init", session: session({ busy: true }), nonce: "n", mode: "structured", conversation: conv })

    const ch = chapters(panel)[0]!
    expect(ch.className).toContain("live")
    expect(ch.querySelector(".narration .cursor")).not.toBeNull()
    const under = ch.querySelector(".under") as DomElement
    expect(under.hidden).toBe(false)
    expect(under.textContent).toContain("now:")
    expect(under.textContent).toContain("bash")
  })

  it("labels a >30s-old unresolved step 'Watching executor' when supervising a child", () => {
    const panel = renderPanel()
    const conv: PresentedConversation = staleToolConv(35_000)
    panel.send({ type: "init", session: session({ busy: true, blockedOn: "subagent" }), nonce: "n", mode: "structured", conversation: conv })
    const under = chapters(panel)[0]!.querySelector(".under") as DomElement
    expect(under.hidden).toBe(false)
    expect(under.textContent).toContain("Watching executor")
    expect(under.textContent).not.toContain("read")
  })

  it("uses the daemon activitySummary for a >30s-old step that isn't supervising", () => {
    const panel = renderPanel()
    const conv = staleToolConv(35_000)
    panel.send({ type: "init", session: session({ busy: true, activitySummary: { text: "Refactored the context provider hook", state: "au travail", at: "" } }), nonce: "n", mode: "structured", conversation: conv })
    const under = chapters(panel)[0]!.querySelector(".under") as DomElement
    expect(under.textContent).toContain("Refactored the context provider hook")
    expect(under.textContent).not.toContain("read")
  })

  it("falls back to 'Working' for a >30s-old step with neither supervision nor a summary", () => {
    const panel = renderPanel()
    const conv = staleToolConv(35_000)
    panel.send({ type: "init", session: session({ busy: true }), nonce: "n", mode: "structured", conversation: conv })
    const under = chapters(panel)[0]!.querySelector(".under") as DomElement
    expect(under.textContent).toContain("Working")
    expect(under.textContent).not.toContain("read")
  })

  it("keeps the real tool name for a fresh (<30s) pending step even while supervising", () => {
    const panel = renderPanel()
    const conv = staleToolConv(3_000)
    panel.send({ type: "init", session: session({ busy: true, blockedOn: "subagent" }), nonce: "n", mode: "structured", conversation: conv })
    const under = chapters(panel)[0]!.querySelector(".under") as DomElement
    expect(under.textContent).toContain("read")
    expect(under.textContent).not.toContain("Watching executor")
  })

  it("omits the elapsed suffix for a step under 5s ('now' is current — '· 0s' is noise)", () => {
    const panel = renderPanel()
    panel.send({ type: "init", session: session({ busy: true }), nonce: "n", mode: "structured", conversation: staleToolConv(2_000) })
    const under = chapters(panel)[0]!.querySelector(".under") as DomElement
    expect(under.textContent).toBe("now: read")
  })

  it("shows seconds for a 5–60s step, minutes for a 60–90s step", () => {
    const panel = renderPanel()
    panel.send({ type: "init", session: session({ busy: true }), nonce: "n", mode: "structured", conversation: staleToolConv(12_000) })
    const seconds = chapters(panel)[0]!.querySelector(".under") as DomElement
    expect(seconds.textContent).toMatch(/^now: read · \d+s$/)

    const panel2 = renderPanel()
    // 70s is past the staleness cutoff too, so the label flips to the
    // supervision/Working fallback — assert the MINUTES suffix regardless.
    panel2.send({ type: "init", session: session({ busy: true }), nonce: "n", mode: "structured", conversation: staleToolConv(70_000) })
    const minutes = chapters(panel2)[0]!.querySelector(".under") as DomElement
    expect(minutes.textContent).toMatch(/^now: .* · 1 min$/)
  })

  it("replaces the whole line with an animated 'Still working…' past 90s — no counter", () => {
    const panel = renderPanel()
    panel.send({ type: "init", session: session({ busy: true }), nonce: "n", mode: "structured", conversation: staleToolConv(120_000) })
    const under = chapters(panel)[0]!.querySelector(".under") as DomElement
    expect(under.textContent).toMatch(/^Still working\.{1,3}$/)
    expect(under.textContent).not.toContain("now:")
    expect(under.textContent).not.toContain("read")
  })

  // The fade/debounce below runs on the webview's real setTimeout, so these
  // tests wait out the windows in real time (see renderPanel's fakeTimers ->
  // the shipped script's setTimeout is not vetted, only its setInterval).
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

  it("ticks seconds on the same label WITHOUT re-fading", async () => {
    const panel = renderPanel()
    const seg = { kind: "tool", id: "t1", toolName: "bash", isError: false, status: "pending", ts: new Date(Date.now() - 6_000).toISOString() } as PresentedToolSegment
    panel.send({ type: "init", session: session({ busy: true }), nonce: "n", mode: "structured", conversation: { version: 1, sessionId: "s1", turns: [{ id: "turn-2", role: "assistant", segments: [seg] }] } })
    const under = chapters(panel)[0]!.querySelector(".under") as DomElement
    await sleep(350) // first label paints synchronously — no fade classes
    expect(under.textContent).toMatch(/^now: bash · \d+s$/)
    expect(under.classList.contains("fading-out")).toBe(false)
    expect(under.classList.contains("fading-in")).toBe(false)
    // Let the 1s quiet-poll tick — the counter moves, the label is unchanged,
    // so no fade classes may appear.
    await sleep(1100)
    expect(under.textContent).toMatch(/^now: bash · \d+s$/)
    expect(under.classList.contains("fading-out")).toBe(false)
    expect(under.classList.contains("fading-in")).toBe(false)
  })

  it("fades a label change old -> new and clears the fade classes", async () => {
    const panel = renderPanel()
    const seg = (name: string, id: string) => ({ kind: "tool", id, toolName: name, isError: false, status: "pending", ts: new Date(Date.now() - 2_000).toISOString() }) as PresentedToolSegment
    panel.send({ type: "init", session: session({ busy: true }), nonce: "n", mode: "structured", conversation: { version: 1, sessionId: "s1", turns: [{ id: "turn-2", role: "assistant", segments: [seg("bash", "t1")] }] } })
    const under = chapters(panel)[0]!.querySelector(".under") as DomElement
    await sleep(350)
    expect(under.textContent).toBe("now: bash")

    // Change the pending step's tool. The target label is set synchronously;
    // the swap lands async (min-display debounce + 220ms fade).
    panel.send({ type: "patch", upsertTurns: [{ id: "turn-2", role: "assistant", segments: [seg("read", "t2")] }], removeTurnIds: [] })
    expect(under.dataset.label).toBe("read")
    await sleep(900) // past min-display (500ms) + fade (220ms)
    expect(under.textContent).toBe("now: read")
    expect(under.classList.contains("fading-out")).toBe(false)
    expect(under.classList.contains("fading-in")).toBe(false)
    expect(under.textContent).not.toContain("bash")
  })

  it("renders the minimalist plan: done collapses to a summary, failed stay visible, current + next up (#conversation-chrome)", () => {
    const panel = renderPanel()
    const plan: PresentedPlanSegment = {
      kind: "plan",
      id: "seg-plan-1",
      done: 2,
      total: 8,
      entries: [
        { content: "done a", priority: "high", status: "completed" },
        { content: "done b", priority: "high", status: "completed" },
        { content: "broken step", priority: "high", status: "failed" },
        { content: "current step", priority: "high", status: "in_progress" },
        { content: "p1", priority: "medium", status: "pending" },
        { content: "p2", priority: "medium", status: "pending" },
        { content: "p3", priority: "medium", status: "pending" },
        { content: "p4", priority: "medium", status: "pending" },
      ],
    }
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [
        { id: "turn-1", role: "user", segments: [{ kind: "user", id: "u1", html: "Plan it" }] },
        {
          id: "turn-2",
          role: "assistant",
          segments: [{ kind: "assistant-text", id: "a1", html: "<p>Working.</p>" }, plan],
        },
      ],
    }
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: conv })

    const planNode = panel.book.querySelector(".notices .seg.plan")!
    expect(planNode.querySelector(".plan-head")?.textContent).toBe("Plan 2/8")
    const fill = planNode.querySelector(".plan-progress-fill") as unknown as { style: { width: string } }
    expect(fill.style.width).toBe("25%")

    // Collapsed: one "✓ 2 done" summary + failed + current + next 3 pending + "+1 more".
    let lis = [...planNode.querySelectorAll(".plan-list li")]
    expect(lis.map(l => l.className.replace("plan-", ""))).toEqual([
      "donesum", "failed", "in_progress", "pending", "pending", "pending", "more",
    ])
    expect(lis[0]?.querySelector(".plan-text")?.textContent).toBe("2 done")
    expect(lis[0]?.querySelector(".plan-chev")).not.toBeNull()
    expect(lis[1]?.querySelector(".plan-text")?.textContent).toBe("broken step")
    expect(lis[2]?.querySelector(".plan-text")?.textContent).toBe("current step")
    expect(lis[6]?.querySelector(".plan-text")?.textContent).toBe("+1 more")
    // No strikethrough anywhere.
    expect(planNode.querySelector('[style*="line-through"]')).toBeNull()

    // Expanding the summary reveals the completed steps as sub-rows.
    ;(lis[0] as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(new panel.window.Event("click"))
    lis = [...planNode.querySelectorAll(".plan-list li")]
    const subTexts = lis.filter(l => l.className.includes("plan-sub")).map(l => l.querySelector(".plan-text")?.textContent)
    expect(subTexts).toEqual(["done a", "done b"])

    // Expanding "+N more" shows the rest of the queue.
    const more = [...planNode.querySelectorAll(".plan-more")].pop()!
    ;(more as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(new panel.window.Event("click"))
    const pendingTexts = [...planNode.querySelectorAll(".plan-pending .plan-text")].map(n => n.textContent)
    expect(pendingTexts).toContain("p4")
  })
})

describe("transcriptPanel webview — cross-session visibility (E2/E3/E4)", () => {
  const el = (panel: Panel, id: string): DomElement => {
    const node = panel.document.getElementById(id)
    if (!node) throw new Error(id + " missing from buildHtml output")
    return node
  }
  function init(panel: Panel, over: Partial<SessionDescriptor> = {}, turns: PresentedTurn[] = []): void {
    panel.send({
      type: "init",
      session: session(over),
      nonce: "n",
      mode: "structured",
      conversation: { version: 1, sessionId: "s1", turns },
    })
  }
  const click = (panel: Panel, id: string): void => {
    el(panel, id).dispatchEvent(new panel.window.Event("click"))
  }

  it("badges an agent-injected user turn with its source and the accent class (E2)", () => {
    const panel = renderPanel()
    init(panel, { status: "running" }, [
      {
        id: "turn-1",
        role: "user",
        promptSource: "agent:sess_b0b0b0",
        segments: [{ kind: "user", id: "seg-1", html: "do the thing" }],
      },
      { id: "turn-2", role: "user", segments: [{ kind: "user", id: "seg-2", html: "typed by me" }] },
    ])

    const nodes = turnNodes(panel).filter(n => n.classList.contains("turn-user"))
    expect(nodes).toHaveLength(2)
    const [injected, human] = nodes as [DomElement, DomElement]
    expect(injected.classList.contains("turn-agent-sourced")).toBe(true)
    const badge = injected.querySelector(".prompt-source-badge")
    // The label carries the id's discriminating TAIL (shortSessionId rule);
    // the full id rides the tooltip.
    expect(badge?.textContent).toBe("⇄ from b0b0b0")
    expect((badge as DomElement | null)?.title).toBe("Injected by session sess_b0b0b0 via agent_prompt")
    // The human's own turn carries neither the class nor the badge.
    expect(human.classList.contains("turn-agent-sourced")).toBe(false)
    expect(human.querySelector(".prompt-source-badge")).toBeNull()
  })

  it("shows an info banner, and its ✕ dismisses by user choice (E3)", () => {
    const panel = renderPanel()
    init(panel, { status: "running" })
    panel.send({ type: "infoBanner", id: "watcher", text: "A watcher attached — 1 waiting on this session" })

    const banner = el(panel, "info-banner")
    expect(banner.hidden).toBe(false)
    expect(el(panel, "ib-text").textContent).toBe("A watcher attached — 1 waiting on this session")

    click(panel, "ib-dismiss")
    expect(banner.hidden).toBe(true)
    // A same-id re-post respects the user's dismissal…
    panel.send({ type: "infoBanner", id: "watcher", text: "A watcher attached — 1 waiting on this session" })
    expect(banner.hidden).toBe(true)
    // …while a NEW id (a new occurrence) shows again.
    panel.send({ type: "infoBanner", id: "agent-msg:7", text: "Message from sess_boss" })
    expect(banner.hidden).toBe(false)
  })

  it("hides the info banner on a matching dismissInfoBanner (auto-dismiss path)", () => {
    const panel = renderPanel()
    init(panel, { status: "running" })
    panel.send({ type: "infoBanner", id: "agent-msg:9", text: "Message from sess_boss" })
    expect(el(panel, "info-banner").hidden).toBe(false)

    // A non-matching id is a stale timer for a banner already replaced — no-op.
    panel.send({ type: "dismissInfoBanner", id: "agent-msg:8" })
    expect(el(panel, "info-banner").hidden).toBe(false)

    panel.send({ type: "dismissInfoBanner", id: "agent-msg:9" })
    expect(el(panel, "info-banner").hidden).toBe(true)
  })

  it("blocked-note ✕ dismisses THIS block only — a new toolCallId shows the note again (E4)", () => {
    vi.useFakeTimers()
    const panel = renderPanel({ fakeTimers: true })
    init(panel, { status: "running", busy: true, blockedOn: "command", pendingToolCallId: "toolu_01ABCDEF" })
    vi.advanceTimersByTime(20_000)
    expect(el(panel, "blocked-note").hidden).toBe(false)

    click(panel, "blocked-note-dismiss")
    expect(el(panel, "blocked-note").hidden).toBe(true)
    // Same block re-announced → stays dismissed.
    panel.send({ type: "sessionUpdate", session: session({ status: "running", busy: true, blockedOn: "command", pendingToolCallId: "toolu_01ABCDEF" }) })
    vi.advanceTimersByTime(1_000)
    expect(el(panel, "blocked-note").hidden).toBe(true)

    // A DIFFERENT tool call is a new block worth showing — the 20s patience
    // window already elapsed for this turn, so it appears on the next repaint.
    panel.send({ type: "sessionUpdate", session: session({ status: "running", busy: true, blockedOn: "command", pendingToolCallId: "toolu_99ZZZZZZ" }) })
    vi.advanceTimersByTime(21_000)
    expect(el(panel, "blocked-note").hidden).toBe(false)
    expect(el(panel, "blocked-note-text").textContent).toBe("blocked on command · toolu_99")
  })
})

describe("transcriptPanel webview — dimmed harness watermark (bottom-left)", () => {
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

  it("mirrors the baked adapter-icon SVG into the watermark, same source as the crisp header icon", () => {
    const panel = renderPanel({ headerIconSvg: '<svg viewBox="0 0 16 16"><path d="M0 0"/></svg>' })
    init(panel, { adapterSlug: "claude-code" })
    const watermark = el(panel, "harness-watermark")
    expect(watermark.innerHTML).toContain("<svg")
    expect(watermark.title).toBe("claude-code")
    expect(watermark.innerHTML).toBe(el(panel, "header-icon").innerHTML)
    // Text-free image mark — no glyph fallback text sitting inside it.
    expect(watermark.querySelector("svg")).not.toBeNull()
  })

  it("stays empty (and so CSS-hidden) when no icon asset was baked in for this adapter", () => {
    const panel = renderPanel({ headerIconSvg: "" })
    init(panel, { adapterSlug: "some-lettermark-only-adapter" })
    expect(el(panel, "harness-watermark").innerHTML).toBe("")
  })
})

describe("transcriptPanel webview — background task chips (#background-tasks-ux)", () => {
  const el = (panel: Panel, id: string): DomElement => {
    const node = panel.document.getElementById(id)
    if (!node) throw new Error(id + " missing from buildHtml output")
    return node
  }

  function bgToolSeg(over: Partial<PresentedToolSegment> = {}): PresentedToolSegment {
    return {
      kind: "tool",
      id: "tool-bg1",
      toolName: "bash",
      argsText: "pnpm dev",
      isError: false,
      status: "pending",
      ts: new Date().toISOString(),
      background: true,
      ...over,
    }
  }

  it("shows one clickable text chip per still-running background tool call", () => {
    const panel = renderPanel()
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [{ id: "turn-1", role: "assistant", segments: [bgToolSeg()] }],
    }
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: conv })

    const strip = el(panel, "bg-chips")
    expect(strip.hidden).toBe(false)
    const chips = [...strip.querySelectorAll(".bgchip")]
    expect(chips).toHaveLength(1)
    expect(chips[0]!.textContent).toBe("bash")
    // Text only — never an image/icon for a bg-task indicator.
    expect(chips[0]!.querySelector("img, svg")).toBeNull()
  })

  it("clicking a chip scrolls to (and flashes) its segment's card", () => {
    const panel = renderPanel()
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [{ id: "turn-1", role: "assistant", segments: [bgToolSeg()] }],
    }
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: conv })

    const target = segNode(panel, "tool-bg1")
    if (!target) throw new Error("unreachable")
    const scrollSpy = vi.fn()
    ;(target as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollSpy

    const chip = el(panel, "bg-chips").querySelector(".bgchip")
    if (!chip) throw new Error("chip missing")
    chip.dispatchEvent(new panel.window.Event("click", { bubbles: true }))

    expect(scrollSpy).toHaveBeenCalled()
    expect(target.className).toContain("seg-flash")
  })

  it("hides the strip once the background call settles, and omits it entirely for a plain (non-background) pending call", () => {
    const panel = renderPanel()
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [{ id: "turn-1", role: "assistant", segments: [bgToolSeg()] }],
    }
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: conv })
    expect(el(panel, "bg-chips").hidden).toBe(false)

    const settledTurn: PresentedTurn = {
      id: "turn-1",
      role: "assistant",
      segments: [{ ...bgToolSeg(), status: "ok", resultText: "done", background: undefined }],
    }
    panel.send({ type: "patch", upsertTurns: [settledTurn], removeTurnIds: [] })
    expect(el(panel, "bg-chips").hidden).toBe(true)
    expect(el(panel, "bg-chips").querySelectorAll(".bgchip")).toHaveLength(0)

    // A never-backgrounded pending call never lit the strip in the first place.
    const panel2 = renderPanel()
    const fgConv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [{ id: "turn-1", role: "assistant", segments: [{ ...bgToolSeg(), background: undefined }] }],
    }
    panel2.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: fgConv })
    expect(el(panel2, "bg-chips").hidden).toBe(true)
  })

  it("disambiguates same-named concurrent background tasks with a #N suffix", () => {
    const panel = renderPanel()
    const conv: PresentedConversation = {
      version: 1,
      sessionId: "s1",
      turns: [
        {
          id: "turn-1",
          role: "assistant",
          segments: [bgToolSeg({ id: "tool-bg1" }), bgToolSeg({ id: "tool-bg2" })],
        },
      ],
    }
    panel.send({ type: "init", session: session(), nonce: "n", mode: "structured", conversation: conv })
    const labels = [...el(panel, "bg-chips").querySelectorAll(".bgchip")].map(c => c.textContent)
    expect(labels.sort()).toEqual(["bash #1", "bash #2"])
  })
})
