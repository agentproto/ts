/**
 * Hot-apply coverage for `defaults.agentPromptInterrupt` /
 * `defaults.messaging.allowSiblings` / `defaults.messaging.agentInterrupt`
 * through the scoped `/mcp/orchestrator` gateway (orchestrator-gateway.ts).
 *
 * These three knobs used to be read ONCE at gateway boot (index.ts's
 * `configDefaults`) and closed over as static values for the daemon's
 * lifetime, so a `config_set` change never took effect without a restart.
 * `createOrchestratorMcpServerFactory`'s returned factory now calls
 * `resolveMessagingDefaults()` fresh on every invocation — and since the
 * factory itself is already rebuilt from scratch on every `/mcp/orchestrator`
 * request (the SDK's stateless pattern — see `serveMcp` in http-server.ts),
 * calling it twice with the config mutated in between reproduces "config_set,
 * then the very next call sees it" without touching the real ~/.agentproto.
 *
 * `loadConfig` is mocked (not the real filesystem) — same pattern as
 * `auth-probe.test.ts` / `session-spawn.test.ts`.
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"

const config = vi.hoisted(() => ({ value: {} as { defaults?: unknown } }))
vi.mock("../config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../config.js")>()
  return { ...actual, loadConfig: vi.fn(async () => config.value) }
})

import {
  createOrchestratorMcpServerFactory,
  createScopeTokenRegistry,
  type OrchestratorScope,
} from "../orchestrator-gateway.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent, type SessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function makeTree(registry: SessionsRegistry) {
  const parent = registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    depth: 0,
  })
  const childA = registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    parentSessionId: parent.id,
    depth: 1,
  })
  const siblingB = registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    parentSessionId: parent.id,
    depth: 1,
  })
  return { parent, childA, siblingB }
}

function makeFactoryDeps() {
  const sessionEvents = createSessionEventBus()
  const eventRing = createEventRing()
  eventRing.wire(sessionEvents)
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  return { registry, sessionEvents, eventRing }
}

async function connectAsScope(
  factory: ReturnType<typeof createOrchestratorMcpServerFactory>,
  scope: OrchestratorScope,
) {
  const server = await factory(scope)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

function bodyOf(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>
}

beforeEach(() => {
  config.value = {}
})

describe("orchestrator gateway — messaging defaults hot-apply (no restart)", () => {
  it("a config_set between two /mcp/orchestrator calls is visible on the very next call, for all three knobs", async () => {
    const deps = makeFactoryDeps()
    const { childA, siblingB } = makeTree(deps.registry)
    // enqueuePrompt is only reached AFTER the urgency/ACL decisions this test
    // cares about — stubbing it keeps the test independent of turn/timing
    // mechanics (same technique as message-parent.test.ts).
    vi.spyOn(deps.registry, "enqueuePrompt").mockResolvedValue({ queued: false })

    const factory = createOrchestratorMcpServerFactory({ workspace: process.cwd(), ...deps })
    const scopeRegistry = createScopeTokenRegistry()
    const scope = scopeRegistry.mint()
    scopeRegistry.bindOwner(scope.token, childA.id)

    // Call 1: config.json defaults (empty file ⇒ false/false/"deny").
    config.value = {}
    const client1 = await connectAsScope(factory, scope)
    const send1 = bodyOf(
      await client1.callTool({ name: "message_send", arguments: { to: siblingB.id, text: "hi" } }),
    )
    expect(send1).toMatchObject({ ok: false, error: "forbidden_recipient" })
    const parent1 = bodyOf(await client1.callTool({ name: "message_parent", arguments: { message: "status" } }))
    expect(parent1).toMatchObject({ ok: true, urgencyApplied: "next-turn" })
    await client1.close()

    // An operator runs `agentproto config set defaults.messaging.allowSiblings
    // true` etc. — no daemon restart.
    config.value = {
      defaults: {
        agentPromptInterrupt: true,
        messaging: { allowSiblings: true, agentInterrupt: "deny" },
      },
    }

    // Call 2: a brand-new `/mcp/orchestrator` request (this factory already
    // rebuilds the whole McpServer per call) — already sees the new config.
    const client2 = await connectAsScope(factory, scope)
    const send2 = bodyOf(
      await client2.callTool({ name: "message_send", arguments: { to: siblingB.id, text: "hi again" } }),
    )
    expect(send2).toMatchObject({ ok: true, relation: "sibling" })
    // `agentPromptInterrupt: true` flips message_parent's unset-`interrupt`
    // default, but `agentInterrupt` is still "deny" — requested "interrupt"
    // is downgraded to "steer" (distinct from call 1's "next-turn").
    const parent2 = bodyOf(await client2.callTool({ name: "message_parent", arguments: { message: "status again" } }))
    expect(parent2).toMatchObject({ ok: true, urgencyApplied: "steer" })
    await client2.close()
  })

  it("an explicit deps override wins over the resolved config value", async () => {
    const deps = makeFactoryDeps()
    const { childA, siblingB } = makeTree(deps.registry)
    vi.spyOn(deps.registry, "enqueuePrompt").mockResolvedValue({ queued: false })

    const factory = createOrchestratorMcpServerFactory({
      workspace: process.cwd(),
      ...deps,
      messagingAllowSiblings: false,
      defaultAgentPromptInterrupt: false,
    })
    const scopeRegistry = createScopeTokenRegistry()
    const scope = scopeRegistry.mint()
    scopeRegistry.bindOwner(scope.token, childA.id)

    // Config says the opposite of the explicit override on both knobs.
    config.value = { defaults: { agentPromptInterrupt: true, messaging: { allowSiblings: true } } }

    const client = await connectAsScope(factory, scope)
    const send = bodyOf(
      await client.callTool({ name: "message_send", arguments: { to: siblingB.id, text: "hi" } }),
    )
    expect(send).toMatchObject({ ok: false, error: "forbidden_recipient" })
    const parent = bodyOf(await client.callTool({ name: "message_parent", arguments: { message: "status" } }))
    expect(parent).toMatchObject({ ok: true, urgencyApplied: "next-turn" })
    await client.close()
  })
})
