/**
 * Regression: `agent_output` must expose a distinct liveness heartbeat so a
 * monitor can tell "alive and working" from "stalled" during a long busy turn.
 *
 * The failure this guards: an agent streams a long thinking / generation
 * stretch that produces NO new coalesced ring LINE for a while, so
 * `lastOutputAt` (and the tailed `lines`) look frozen — while the session is
 * very much alive. `agent_sessions_list` already advances `lastActivityAt` on
 * any adapter-process activity; here we assert `agent_output` surfaces the same
 * heartbeat (plus the live `processAlive` OS check), so a caller polling
 * `agent_output` alone can distinguish the two without a second tool call.
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type SessionsRegistry,
} from "../sessions.js"

async function buildHarness(
  registry: SessionsRegistry,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerAgentTools(server, { registry })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)
  return { client, close: () => client.close() }
}

function jsonOf(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content
  return JSON.parse(content?.[0]?.text ?? "{}") as Record<string, unknown>
}

describe("agent_output — liveness heartbeat", () => {
  it("surfaces lastActivityAt (advancing) + processAlive even when the ring/lastOutputAt looks frozen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-output-hb-"))
    const registry = createSessionsRegistry({
      persistPath: join(dir, "sessions.json"),
      persist: false,
    })
    // A turn that writes ONE line then ends — this is the last ring line the
    // caller ever sees; `lastOutputAt` freezes here.
    const fakeAgent: AgentSessionLike = {
      sessionId: "acp-hb-1",
      // Point at this test process so the live processAlive OS check is true.
      pid: process.pid,
      async *send() {
        yield { kind: "text-delta", text: "starting long task…\n" }
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: dir,
      agentSession: fakeAgent,
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    // Let the fire-and-forget turn drain: sets lastOutputAt + the ring line.
    await new Promise((r) => setTimeout(r, 20))
    const frozenOutputAt = registry.get(desc.id)?.lastOutputAt
    expect(frozenOutputAt).toBeDefined()

    // Now simulate the "alive but no new ring line" stretch: the adapter keeps
    // pulsing activity (streamed thinking deltas, tool traffic) without emitting
    // a new coalesced line. `lastActivityAt` advances past `lastOutputAt`.
    await new Promise((r) => setTimeout(r, 5))
    registry.pulseActivity(desc.id)
    const activityAt = registry.get(desc.id)?.lastActivityAt
    expect(activityAt).toBeDefined()
    expect(new Date(activityAt!).getTime()).toBeGreaterThan(
      new Date(frozenOutputAt!).getTime(),
    )

    const harness = await buildHarness(registry)
    try {
      const payload = jsonOf(
        await harness.client.callTool({
          name: "agent_output",
          arguments: { sessionId: desc.id, clean: true },
        }),
      )
      // lastOutputAt is the frozen one …
      expect(payload.lastOutputAt).toBe(frozenOutputAt)
      // … but the heartbeat is exposed and strictly ahead of it, so a monitor
      // reads "alive and working", not "stalled".
      expect(payload.lastActivityAt).toBe(activityAt)
      expect(new Date(payload.lastActivityAt as string).getTime()).toBeGreaterThan(
        new Date(payload.lastOutputAt as string).getTime(),
      )
      // Live OS check — the fake agent's pid is this test process, so alive.
      expect(payload.processAlive).toBe(true)
      expect(payload.currentPhase).toBe("idle")
      expect(payload.toolCallsThisTurn).toBe(0)
      expect(payload.secondsSinceLastActivity).toBeTypeOf("number")
    } finally {
      await harness.close()
      registry.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
