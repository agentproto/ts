/**
 * `session_tree`'s `reviews` badge (review-session-panel step, Goal A item
 * 3): a node that requested a review carries the latest 3 as
 * `{runId, verdict, binding, range, at}`, sourced from a single index-backed
 * `ReviewLedger.list({requesterSessionIds})` call plus the in-process
 * `ReviewRunner.list()` (for running/cancelled runs that never reach the
 * ledger) — never a per-node ledger scan. A fake `ReviewRunner` stands in for
 * the real one (review-runner.test.ts covers that against a real repo).
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { ATTESTATION_SCHEMA, type Attestation } from "@agentproto/review"

import { registerSessionTools, type SessionTreeNode } from "../session-tools.js"
import {
  createSessionsRegistry,
  type SessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionDescriptor,
} from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { ReviewRunner, ReviewRun } from "../review-runner.js"
import type { LedgerEntry, ReviewLedgerFilter, LedgerAnnotations } from "../review-ledger.js"

let acpCounter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function spawnNode(registry: SessionsRegistry, parentSessionId?: string): SessionDescriptor {
  return registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    ...(parentSessionId ? { parentSessionId } : {}),
  })
}

function fakeAttestation(overrides: Partial<Attestation> & { requesterSessionId: string }): Attestation {
  const { requesterSessionId, ...rest } = overrides
  return {
    schema: ATTESTATION_SCHEMA,
    runId: "review-fixed",
    reviewId: "demo",
    manifestSha: "m".repeat(64),
    binding: "default",
    target: { repoRemote: "github.com/acme/demo", baseSha: "b".repeat(40), headSha: "h".repeat(40) },
    rangeSha: "r".repeat(64),
    lanes: [],
    verdict: "pass",
    attestor: { daemon: "test", presets: [] },
    rubrics: [],
    requester: { sessionId: requesterSessionId },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...rest,
  }
}

function fakeLedgerEntry(a: Attestation): LedgerEntry {
  return { attestation: a, host: { repoRoot: "/tmp/repo", manifestPath: "/tmp/repo/REVIEW.md" } }
}

function fakeReviewRunner(opts: { runs?: ReviewRun[]; entries?: LedgerEntry[] } = {}): ReviewRunner {
  const entries = opts.entries ?? []
  return {
    start: () => {
      throw new Error("not implemented in fake")
    },
    status: async () => undefined,
    wait: async () => undefined,
    cancel: () => false,
    list: () => opts.runs ?? [],
    ledger: {
      root: "/tmp/fake-ledger",
      async put(entry) {
        entries.push(entry)
        return "/tmp/fake-ledger/entry.json"
      },
      async get() {
        return undefined
      },
      async lookupCached() {
        return undefined
      },
      async findByRunId() {
        return undefined
      },
      async list(filter: ReviewLedgerFilter = {}) {
        if (!filter.requesterSessionIds) return entries
        const ids = new Set(filter.requesterSessionIds)
        return entries.filter(e => {
          const sid = e.attestation.requester?.sessionId
          return sid !== undefined && ids.has(sid)
        })
      },
      async getAnnotations(): Promise<LedgerAnnotations> {
        return {}
      },
      async updateAnnotations(_key, update) {
        return update({})
      },
    },
  }
}

interface Harness {
  client: Client
  registry: SessionsRegistry
}

async function buildHarness(reviewRunner?: ReviewRunner): Promise<Harness> {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, {
    workspace: process.cwd(),
    registry,
    ...(reviewRunner ? { reviewRunner } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return { client, registry }
}

function payload<T = Record<string, unknown>>(result: unknown): T {
  const content = (result as { content: Array<{ text: string }> }).content
  return JSON.parse(content[0]!.text) as T
}

describe("session_tree — reviews badge", () => {
  it("is absent when no reviewRunner is wired (unchanged output)", async () => {
    const { client, registry } = await buildHarness()
    const s = spawnNode(registry)
    const res = payload<{ tree: SessionTreeNode[] }>(await client.callTool({ name: "session_tree", arguments: {} }))
    const node = res.tree.find(n => n.id === s.id)!
    expect(node.reviews).toBeUndefined()
  })

  it("attaches the latest 3 badges (newest first) only to the requesting node", async () => {
    const entries: LedgerEntry[] = []
    const runner = fakeReviewRunner({ entries })
    const { client, registry } = await buildHarness(runner)
    const requester = spawnNode(registry)
    const other = spawnNode(registry)
    entries.push(
      ...[
        fakeAttestation({ requesterSessionId: requester.id, runId: "r1", verdict: "pass", createdAt: "2026-01-01T00:00:00.000Z" }),
        fakeAttestation({ requesterSessionId: requester.id, runId: "r2", verdict: "block", createdAt: "2026-01-02T00:00:00.000Z" }),
        fakeAttestation({ requesterSessionId: requester.id, runId: "r3", verdict: "incomplete", createdAt: "2026-01-03T00:00:00.000Z" }),
        fakeAttestation({ requesterSessionId: requester.id, runId: "r4", verdict: "pass", createdAt: "2026-01-04T00:00:00.000Z" }),
      ].map(fakeLedgerEntry),
    )
    const res = payload<{ tree: SessionTreeNode[] }>(await client.callTool({ name: "session_tree", arguments: {} }))
    const requesterNode = res.tree.find(n => n.id === requester.id)!
    const otherNode = res.tree.find(n => n.id === other.id)!
    expect(otherNode.reviews).toBeUndefined()
    expect(requesterNode.reviews).toHaveLength(3)
    expect(requesterNode.reviews!.map(b => b.runId)).toEqual(["r4", "r3", "r2"])
    expect(requesterNode.reviews![0]).toMatchObject({
      runId: "r4",
      verdict: "pass",
      binding: "default",
      range: `${"b".repeat(7)}..${"h".repeat(7)}`,
    })
  })

  it("a running run (no ledger entry yet) shows verdict: running", async () => {
    const runs: ReviewRun[] = []
    const runner = fakeReviewRunner({ runs })
    const { client, registry } = await buildHarness(runner)
    const requester = spawnNode(registry)
    runs.push({
      runId: "review-live",
      status: "running",
      startedAt: "2026-01-05T00:00:00.000Z",
      binding: "default",
      baseSha: "b".repeat(40),
      headSha: "h".repeat(40),
      lanes: [],
      requesterSessionId: requester.id,
    })
    const res = payload<{ tree: SessionTreeNode[] }>(await client.callTool({ name: "session_tree", arguments: {} }))
    const requesterNode = res.tree.find(n => n.id === requester.id)!
    expect(requesterNode.reviews).toEqual([
      { runId: "review-live", verdict: "running", binding: "default", range: `${"b".repeat(7)}..${"h".repeat(7)}`, at: "2026-01-05T00:00:00.000Z" },
    ])
  })

  it("nav-mode `children` slice also carries badges", async () => {
    const entries: LedgerEntry[] = []
    const runner = fakeReviewRunner({ entries })
    const { client, registry } = await buildHarness(runner)
    const root = spawnNode(registry)
    const child = spawnNode(registry, root.id)
    entries.push(fakeLedgerEntry(fakeAttestation({ requesterSessionId: child.id, runId: "r1" })))
    const res = payload<{ children: SessionTreeNode[] }>(
      await client.callTool({ name: "session_tree", arguments: { nodeId: root.id, direction: "children" } }),
    )
    expect(res.children).toHaveLength(1)
    expect(res.children[0]!.reviews).toHaveLength(1)
    expect(res.children[0]!.reviews![0]!.runId).toBe("r1")
  })
})
