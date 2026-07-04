/**
 * End-to-end coverage for per-session usage observability:
 *   - the `usage_update` stream + turn-end refresh populate the descriptor's
 *     cost / token / context fields (part ①),
 *   - the `"computed"` (tokens × in-repo catalog price) and `"no-pricing"`
 *     (unknown model → no fabricated cost) branches (part ②),
 *   - `session_list` projects the usage fields and `session_usage` returns the
 *     documented shape (part ①),
 *   - a durable `usage_snapshot` record lands in the transcript at turn-end
 *     (part ③).
 *
 * Uses the REAL in-repo pricing catalog so the computed dollar figure is
 * asserted against actual `claude-sonnet-4-5` rates (in=$3/1M, out=$15/1M).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { registerSessionTools } from "../session-tools.js"
import { sessionEventsPath } from "../transcript-writer.js"

interface UsageEvent {
  size?: number
  used?: number
  tokensIn?: number
  tokensOut?: number
  cost?: { amount: number; currency: string }
}

/** Fake agent session that streams one usage_update then completes a turn. */
function usageAgentSession(usage: UsageEvent): AgentSessionLike {
  return {
    sessionId: "usage-adapter-sess",
    async *send() {
      yield { kind: "usage_update", ...usage }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

function parseToolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text) as Record<string, unknown>
}

/** Read the transcript's usage_snapshot records, retrying briefly so the
 *  append stream has flushed. */
async function readUsageSnapshots(
  path: string,
): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (existsSync(path)) {
      const records = readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .filter(r => r.kind === "usage_snapshot")
      if (records.length > 0) return records
    }
    await new Promise(r => setTimeout(r, 25))
  }
  return []
}

describe("per-session usage observability (MCP e2e)", () => {
  let tmp: string
  let transcriptDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "usage-test-"))
    transcriptDir = join(tmp, "sessions")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  async function connectTools(registry: ReturnType<typeof createSessionsRegistry>) {
    const server = new McpServer({ name: "usage-test", version: "0.0.0" })
    registerSessionTools(server, { registry })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "usage-client", version: "0.0.0" })
    await client.connect(clientTransport)
    return client
  }

  it("computed path: prices tokens against the catalog, projects fields, writes a durable snapshot", async () => {
    const registry = createSessionsRegistry({
      persist: false,
      transcriptDir,
      sessionEvents: createSessionEventBus(),
    })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: usageAgentSession({
        size: 200_000,
        used: 42_000,
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
      }),
      adapterSlug: "claude-code",
      model: "claude-sonnet-4-5",
    })
    await registry.sendPrompt(desc.id, "hello")

    // Descriptor was refreshed by the turn-end usage resolution.
    const live = registry.get(desc.id)
    expect(live?.usageSource).toBe("computed")
    // 1M×$3/1M + 1M×$15/1M = $18
    expect(live?.costUsd).toBeCloseTo(18, 10)
    expect(live?.tokensIn).toBe(1_000_000)
    expect(live?.tokensOut).toBe(1_000_000)
    expect(live?.contextSize).toBe(200_000)
    expect(live?.contextUsed).toBe(42_000)

    const client = await connectTools(registry)

    // ── session_list projects the usage fields onto the entry ──
    const listRes = await client.callTool({ name: "session_list", arguments: { kind: "agent-cli" } })
    const list = parseToolJson(listRes) as { sessions: Array<Record<string, unknown>> }
    const entry = list.sessions.find(s => s.id === desc.id)
    expect(entry).toBeDefined()
    expect(entry?.costUsd).toBeCloseTo(18, 10)
    expect(entry?.tokensIn).toBe(1_000_000)
    expect(entry?.contextUsed).toBe(42_000)
    expect(entry?.usageSource).toBe("computed")

    // ── session_usage returns the documented shape ──
    const usageRes = await client.callTool({ name: "session_usage", arguments: { idOrName: desc.id } })
    const usage = parseToolJson(usageRes)
    expect(usage).toMatchObject({
      sessionId: desc.id,
      model: "claude-sonnet-4-5",
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
      contextSize: 200_000,
      contextUsed: 42_000,
      source: "computed",
    })
    expect(usage.costUsd).toBeCloseTo(18, 10)

    // ── durable snapshot written at turn-end ──
    const snapshots = await readUsageSnapshots(sessionEventsPath(desc.id, transcriptDir))
    expect(snapshots.length).toBeGreaterThanOrEqual(1)
    const snap = snapshots[snapshots.length - 1]!
    expect(snap.source).toBe("computed")
    expect(snap.model).toBe("claude-sonnet-4-5")
    expect(snap.costUsd).toBeCloseTo(18, 10)
    expect(snap.tokensIn).toBe(1_000_000)

    registry.shutdown()
  })

  it("no-pricing path: unknown model surfaces tokens but never fabricates a cost", async () => {
    const registry = createSessionsRegistry({
      persist: false,
      transcriptDir,
      sessionEvents: createSessionEventBus(),
    })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: usageAgentSession({ size: 128_000, used: 9_000, tokensIn: 500, tokensOut: 250 }),
      adapterSlug: "mastracode",
      model: "totally-unknown-model-zzz",
    })
    await registry.sendPrompt(desc.id, "hi")

    const client = await connectTools(registry)
    const usageRes = await client.callTool({ name: "session_usage", arguments: { idOrName: desc.id } })
    const usage = parseToolJson(usageRes)
    expect(usage.source).toBe("no-pricing")
    expect(usage.costUsd).toBeUndefined()
    expect("costUsd" in usage).toBe(false)
    // Tokens + context still reported.
    expect(usage.tokensIn).toBe(500)
    expect(usage.tokensOut).toBe(250)
    expect(usage.contextUsed).toBe(9_000)

    const snapshots = await readUsageSnapshots(sessionEventsPath(desc.id, transcriptDir))
    const snap = snapshots[snapshots.length - 1]!
    expect(snap.source).toBe("no-pricing")
    expect("costUsd" in snap).toBe(false)

    registry.shutdown()
  })

  it("adapter path: a usage_update cost block wins and is tagged source=adapter", async () => {
    const registry = createSessionsRegistry({
      persist: false,
      transcriptDir,
      sessionEvents: createSessionEventBus(),
    })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: usageAgentSession({
        size: 200_000,
        used: 1_000,
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
        cost: { amount: 0.99, currency: "USD" },
      }),
      adapterSlug: "claude-code",
      model: "claude-sonnet-4-5",
    })
    await registry.sendPrompt(desc.id, "hi")

    const usage = registry.get(desc.id)
    expect(usage?.usageSource).toBe("adapter")
    // Adapter's own $0.99 wins over the $18 the tokens would have computed.
    expect(usage?.costUsd).toBeCloseTo(0.99, 10)

    registry.shutdown()
  })

  it("session_usage errors for an unknown session", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const client = await connectTools(registry)
    const res = await client.callTool({ name: "session_usage", arguments: { idOrName: "nope" } })
    expect((res as { isError?: boolean }).isError).toBe(true)
    registry.shutdown()
  })
})
