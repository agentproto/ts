import { test } from "node:test"
import assert from "node:assert/strict"
import {
  Inbox,
  baselineEvents,
  effectiveController,
  route,
  type BusEvent,
  type RoutingContext,
  type SessionNode,
} from "./supervision-router.ts"

const WS = "ws"
const HUMAN = { kind: "human" as const, channel: "chat-relay" }
const brain = { kind: "session" as const, id: "brain" }

function ctx(nodes: SessionNode[], over: Partial<RoutingContext> = {}): RoutingContext {
  return {
    sessions: new Map(nodes.map(n => [n.id, n])),
    edges: [],
    subscriptions: [],
    workspaces: new Map([[WS, { workspace: WS, defaultController: brain, fallback: HUMAN }]]),
    ...over,
  }
}

let seq = 0
function ev(over: Partial<BusEvent>): BusEvent {
  seq++
  return {
    id: `evt_${seq}`,
    seq,
    type: "agentproto.session.turn_ended",
    subject: "session:x",
    workspace: WS,
    priority: "attention",
    summary: "s",
    ...over,
  }
}

test("a ROOT session launched by someone else still reaches the workspace default supervisor", () => {
  // Measured failure #1: roots spawned by an external supervisor never woke the brain.
  const c = ctx([
    { id: "brain", workspace: WS, alive: true },
    { id: "root1", workspace: WS, alive: true },
  ])
  const r = route(c, ev({ sessionId: "root1", subject: "session:root1" }))
  assert.deepEqual(r.recipients, [brain])
  assert.equal(effectiveController(c, "root1")?.via, "workspace-default")
})

test("a subtree subscription is inherited by grandchildren", () => {
  const c = ctx(
    [
      { id: "brain", workspace: WS, alive: true },
      { id: "obs", workspace: WS, alive: true },
      { id: "a", workspace: WS, alive: true },
      { id: "b", parentId: "a", workspace: WS, alive: true },
      { id: "c", parentId: "b", workspace: WS, alive: true },
    ],
    {
      subscriptions: [
        { id: "sub1", subscriber: { kind: "session", id: "obs" }, workspace: WS, session: { id: "a", scope: "subtree" } },
      ],
    },
  )
  const r = route(c, ev({ sessionId: "c" }))
  assert.ok(r.recipients.some(p => p.kind === "session" && p.id === "obs"))
})

test("a dead controller escalates to the next live supervisor up the tree, then to the human fallback", () => {
  const nodes: SessionNode[] = [
    { id: "brain", workspace: WS, alive: false },
    { id: "sup", workspace: WS, alive: false },
    { id: "kid", parentId: "sup", workspace: WS, alive: true },
  ]
  const edges = [
    { sessionId: "sup", role: "controller" as const, holder: { kind: "session" as const, id: "sup" }, scope: "subtree" as const, epoch: 1 },
  ]
  const r = route(ctx(nodes, { edges }), ev({ sessionId: "kid", priority: "critical" }))
  assert.deepEqual(r.recipients, [HUMAN])
  assert.equal(r.escalated, true)
  assert.equal(r.undeliverable, false)
})

test("info events never escalate and are not 'undeliverable'", () => {
  const c = ctx([{ id: "lonely", workspace: WS, alive: true }], {
    workspaces: new Map([[WS, { workspace: WS }]]),
  })
  const r = route(c, ev({ sessionId: "lonely", priority: "info" }))
  assert.equal(r.recipients.length, 0)
  assert.equal(r.undeliverable, false)
})

test("no supervisor and no fallback is reported as undeliverable (health sweep must flag it)", () => {
  const c = ctx([{ id: "lonely", workspace: WS, alive: true }], {
    workspaces: new Map([[WS, { workspace: WS }]]),
  })
  assert.equal(route(c, ev({ sessionId: "lonely" })).undeliverable, true)
})

test("repo-level subscription: one watch, many subscribers, no per-PR wiring", () => {
  const c = ctx(
    [
      { id: "brain", workspace: WS, alive: true },
      { id: "author", workspace: WS, alive: true },
    ],
    {
      subscriptions: [
        { id: "s1", subscriber: brain, workspace: WS, subjects: ["github:org/repo#*"], types: ["github.pull_request.*"] },
      ],
    },
  )
  const r = route(c, ev({ type: "github.pull_request.opened", subject: "github:org/repo#421", sessionId: "author" }))
  assert.ok(r.recipients.some(p => p.kind === "session" && p.id === "brain"))
})

test("inbox: same event id twice is a duplicate (at-least-once upstream is safe)", () => {
  const ib = new Inbox(brain)
  const e = ev({ subject: "github:org/repo#1" })
  assert.equal(ib.deliver(e), "wake")
  assert.equal(ib.deliver(e), "duplicate")
})

test("inbox: CI noise on one PR coalesces into ONE unread entry; the terminal event still wakes", () => {
  const ib = new Inbox(brain)
  const subject = "github:org/repo#7"
  assert.equal(ib.deliver(ev({ subject, type: "github.check_suite.completed", priority: "info" })), "digest")
  for (let i = 0; i < 20; i++) {
    assert.equal(ib.deliver(ev({ subject, type: "github.check_suite.completed", priority: "info" })), "coalesced")
  }
  assert.equal(ib.deliver(ev({ subject, type: "github.pull_request.ready", priority: "attention", summary: "ready" })), "wake")
  assert.equal(ib.deliver(ev({ subject, type: "github.pull_request.closed", priority: "attention", terminal: true, summary: "merged" })), "wake")
  const unread = ib.unread()
  assert.equal(unread.length, 1)
  assert.equal(unread[0]!.count, 23)
  assert.equal(unread[0]!.summary, "merged")
})

test("inbox: after ack, the next event on the subject opens a fresh entry", () => {
  const ib = new Inbox(brain)
  const subject = "session:a"
  const first = ev({ subject })
  ib.deliver(first)
  ib.ackThrough(first.seq)
  assert.equal(ib.deliver(ev({ subject })), "wake")
  assert.equal(ib.unread().length, 1)
})

test("inbox: quiet hours defer non-critical to a human, critical goes through", () => {
  const ib = new Inbox(HUMAN, { quietHours: { start: 22, end: 8 } })
  assert.equal(ib.deliver(ev({ subject: "s1", priority: "attention" }), { hour: 23 }), "digest")
  assert.equal(ib.deliver(ev({ subject: "s2", priority: "critical" }), { hour: 23 }), "wake")
  assert.equal(ib.deliver(ev({ subject: "s3", priority: "attention" }), { hour: 10 }), "wake")
})

test("inbox: a critical event for a busy agent recipient is steered into the running turn", () => {
  const ib = new Inbox(brain)
  assert.equal(ib.deliver(ev({ subject: "s", priority: "critical" }), { recipientBusy: true }), "steer")
})

test("watching an already-merged PR delivers the terminal event and closes the watch", () => {
  const b = baselineEvents("github:org/repo#417", { state: "merged", fetchedAt: "t" })
  assert.equal(b.closeWatch, true)
  assert.equal(b.events[0]!.terminal, true)
  assert.deepEqual(baselineEvents("github:org/repo#5", { state: "open", fetchedAt: "t" }), { events: [], closeWatch: false })
})
