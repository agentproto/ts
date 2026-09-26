/**
 * Workflow agent-step sessions through the REAL `SessionsRegistryAgentHost`
 * + sessions registry: labelled `wf:<workflowId>/<stepKey>` with the run
 * linked in `meta` (not anonymous depth-0 `agent-step:<adapter>` roots), and
 * ended + archived once the run is done with them — the maintain dry run's
 * 13 reviewer sessions stayed open forever. `releaseAll` is the cancel path.
 */

import { describe, it, expect, vi } from "vitest"
import { runWorkflow, type RuntimeWorkflow } from "@agentproto/workflow-runtime"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { SessionsRegistryAgentHost } from "../sessions-registry-agent-host.js"
import type { AgentAdapterResolver } from "../http-server.js"

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    close: vi.fn(async () => {}),
  }
}

function setup(run?: { runId: string; workflowId: string }) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const resolveAgentAdapter: AgentAdapterResolver = vi.fn(async () => ({
    startSession: async () => fakeAgentSession(),
    commandPreview: "fake",
  }))
  const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter, run ? { run } : undefined)
  // The turn itself is irrelevant — only spawn metadata + release are under test.
  host.sendPromptAndWait = vi.fn(async () => {})
  host.readFinalMessage = vi.fn(async () => "ok")
  return { registry, host }
}

describe("agent-step session labelling + release", () => {
  it("map item sessions are labelled wf:<wf>/<step>[i], linked to the run, then ended + archived", async () => {
    const { registry, host } = setup({ runId: "wfrun_1", workflowId: "maintain" })
    const wf: RuntimeWorkflow = {
      id: "maintain",
      steps: [
        {
          kind: "map",
          id: "reviews",
          parallelism: 2,
          over: () => ["a", "b", "c"],
          body: () => ({ kind: "agent", id: "review", adapter: "claude-code", prompt: () => "go" }),
        },
      ],
    }
    const { output } = await runWorkflow({ workflow: wf, agents: host })
    const ids = (output as Array<{ sessionId: string }>).map((o) => o.sessionId)
    expect(ids).toHaveLength(3)
    ids.forEach((id, i) => {
      const d = registry.get(id)!
      expect(d.label).toBe(`wf:maintain/review[${i}]`)
      expect(d.origin).toBe("workflow")
      expect(d.meta).toEqual({ workflowRunId: "wfrun_1", workflowId: "maintain", workflowStepId: `review[${i}]` })
      expect(d.status).toBe("killed")
      expect(d.archived).toBe(true)
      // the indexed step key resolves to its own item's session
      expect(host.resolveByLabel(`review[${i}]`)).toBe(id)
    })
  })

  it("without a run binding the legacy agent-step:<adapter> label stays", async () => {
    const { registry, host } = setup()
    const id = await host.spawn("claude-code", { stepId: "s" })
    expect(registry.get(id)!.label).toBe("agent-step:claude-code")
    expect(registry.get(id)!.meta).toBeUndefined()
  })

  it("releaseAll (cancel) ends + archives every open step session; release is idempotent and host-scoped", async () => {
    const { registry, host } = setup({ runId: "wfrun_2", workflowId: "wf" })
    const a = await host.spawn("claude-code", { stepId: "a" })
    const b = await host.spawn("claude-code", { stepId: "b" })
    expect(registry.get(a)!.status).toBe("running")
    await host.releaseAll()
    for (const id of [a, b]) {
      expect(registry.get(id)!.status).toBe("killed")
      expect(registry.get(id)!.archived).toBe(true)
    }
    // a second release (engine scope settling after cancel) is a no-op
    registry.unarchiveSession(a)
    await host.releaseSession(a)
    expect(registry.get(a)!.archived).toBe(false)
  })
})
