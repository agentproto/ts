/**
 * Derived interception level (AH-18a): `deriveInterception` is a pure
 * function of the session arm, `permissionHold` and the harness's declared
 * native hooks, and `session_capabilities.interception` exposes it.
 */

import { describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import {
  deriveInterception,
  interceptionFor,
  toActionInterception,
  type InterceptionLevel,
} from "../action-hooks/interception.js"
import type { ActionInterception } from "../action-hooks/types.js"
import { buildSessionCapabilities } from "../session-capabilities.js"
import { registerSessionTools } from "../session-tools.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type PtyFactory,
} from "../sessions.js"

type Hook = {
  event: string
  native_event: string
  path: "admission" | "lifecycle"
  can_block: boolean
  handlers: readonly ("command" | "mcp" | "http" | "prompt" | "agent")[]
  async?: boolean
}

function hook(event: string, can_block: boolean, extra: Partial<Hook> = {}): Hook {
  return { event, native_event: `native-${event}`, path: "admission", can_block, handlers: ["command"], ...extra }
}

describe("I1 nativeToolCalls per arm", () => {
  it.each([
    ["acp", true, "permission-gate"],
    ["acp", false, "observe"],
    ["print", false, "observe"],
    ["print", true, "observe"],
    ["pty", false, "unavailable"],
    ["other", false, "unavailable"],
    ["pty", true, "unavailable"],
  ] as const)("arm %s, permissionHold %s -> %s", (arm, permissionHold, expected) => {
    expect(deriveInterception({ arm, permissionHold }).nativeToolCalls).toBe(expected)
  })
})

describe("I2 nativeHooks", () => {
  const derive = (hooks?: readonly Hook[]) => deriveInterception({ arm: "acp", permissionHold: false, hooks })

  it("an event named like an Object.prototype member survives as an own key", () => {
    const d = derive([hook("__proto__", true), hook("toString", false)])
    expect(Object.keys(d.nativeHooks).sort()).toEqual(["__proto__", "toString"])
    expect(interceptionFor(d, "__proto__")).toBe("permission-gate")
    expect(interceptionFor(d, "toString")).toBe("observe")
    expect(interceptionFor(d, "constructor")).toBe("unavailable")
  })

  it("a blocking entry is permission-gate, a non-blocking one is observe", () => {
    expect(derive([hook("tool.call", true)]).nativeHooks).toEqual({ "tool.call": "permission-gate" })
    expect(derive([hook("tool.call", false)]).nativeHooks).toEqual({ "tool.call": "observe" })
  })

  it("several entries for one event: the strongest level wins, in either order", () => {
    expect(derive([hook("tool.call", false), hook("tool.call", true)]).nativeHooks).toEqual({
      "tool.call": "permission-gate",
    })
    expect(derive([hook("tool.call", true), hook("tool.call", false)]).nativeHooks).toEqual({
      "tool.call": "permission-gate",
    })
    expect(derive([hook("tool.call", false), hook("tool.call", false)]).nativeHooks).toEqual({
      "tool.call": "observe",
    })
  })

  it("a can_block + async entry still reports the declared capability", () => {
    expect(derive([hook("tool.call", true, { async: true })]).nativeHooks).toEqual({
      "tool.call": "permission-gate",
    })
  })

  it("no hooks, an empty list and undefined all give an empty map", () => {
    expect(deriveInterception({ arm: "acp", permissionHold: false }).nativeHooks).toEqual({})
    expect(derive([]).nativeHooks).toEqual({})
    expect(derive(undefined).nativeHooks).toEqual({})
  })

  it("interceptionFor of an event that is not declared is unavailable", () => {
    const d = derive([hook("tool.call", true)])
    expect(interceptionFor(d, "tool.call")).toBe("permission-gate")
    expect(interceptionFor(d, "session.start")).toBe("unavailable")
    expect(interceptionFor(d, "toString")).toBe("unavailable")
  })
})

describe("I3 conversion to ActionInterception", () => {
  it("maps each public level to its runtime enum value", () => {
    expect(toActionInterception("intercept")).toBe("full")
    expect(toActionInterception("permission-gate")).toBe("permission-only")
    expect(toActionInterception("observe")).toBe("observe-only")
    expect(toActionInterception("unavailable")).toBe("unavailable")
  })

  it("is total and injective over the union", () => {
    const expected: Record<InterceptionLevel, ActionInterception> = {
      intercept: "full",
      "permission-gate": "permission-only",
      observe: "observe-only",
      unavailable: "unavailable",
    }
    const levels = Object.keys(expected) as InterceptionLevel[]
    const out = levels.map(l => toActionInterception(l))
    expect(out).toEqual(levels.map(l => expected[l]))
    expect(new Set(out).size).toBe(levels.length)
  })
})

describe("I4 exposure in session_capabilities", () => {
  const blocking = [hook("tool.call", true)]

  function agent(withSteer: boolean): AgentSessionLike {
    return {
      sessionId: "s",
      // eslint-disable-next-line require-yield
      async *send(): AsyncIterable<AgentStreamEvent> {
        return
      },
      async cancel() {},
      async close() {},
      ...(withSteer ? { steer: async () => "steered" as const } : {}),
    }
  }

  it("an acp session with permissionHold and a blocking hook reports both levels", () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: agent(true),
      adapterSlug: "mock",
      permissionHold: true,
      nativeHooks: blocking,
    })
    const body = buildSessionCapabilities(registry.get(desc.id)!, 0)
    expect(body.interception).toEqual({
      nativeToolCalls: "permission-gate",
      nativeHooks: { "tool.call": "permission-gate" },
    })
    registry.shutdown()
  })

  it("the same session without hold is observe for tool calls, the hook is still declared", () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: agent(true),
      adapterSlug: "mock",
      nativeHooks: blocking,
    })
    const body = buildSessionCapabilities(registry.get(desc.id)!, 0)
    expect(body.interception).toEqual({
      nativeToolCalls: "observe",
      nativeHooks: { "tool.call": "permission-gate" },
    })
    registry.shutdown()
  })

  it("a print-arm session without hooks is observe with an empty hook map", () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: agent(false),
      adapterSlug: "mock",
    })
    const body = buildSessionCapabilities(registry.get(desc.id)!, 0)
    expect(body.interception).toEqual({ nativeToolCalls: "observe", nativeHooks: {} })
    registry.shutdown()
  })

  it("a terminal session has no interception key", () => {
    const factory: PtyFactory = () => ({
      pid: 1,
      write() {},
      resize() {},
      kill() {},
      onData() {},
      onExit() {},
    })
    const registry = createSessionsRegistry({ persist: false, spawnPty: factory })
    const desc = registry.spawnPty({ workspaceSlug: "w", cwd: "/tmp", argv: ["bash"], cols: 80, rows: 24 })
    const body = buildSessionCapabilities(registry.get(desc.id)!, 0)
    expect(body.arm).toBe("pty")
    expect("interception" in body).toBe(false)
    registry.shutdown()
  })

  it("the field reaches the session_capabilities MCP tool body", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const server = new McpServer({ name: "interception-test", version: "0" })
    registerSessionTools(server, { registry, workspace: process.cwd() })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "interception-test-client", version: "0" })
    await client.connect(clientTransport)
    try {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        adapterSlug: "claude-code",
        agentSession: agent(true),
        permissionHold: true,
        nativeHooks: blocking,
      })
      const result = await client.callTool({ name: "session_capabilities", arguments: { sessionId: desc.id } })
      expect(result.isError).toBeFalsy()
      const content = (result as { content: { text: string }[] }).content
      const body = JSON.parse(content[0]!.text)
      expect(body.interception).toEqual({
        nativeToolCalls: "permission-gate",
        nativeHooks: { "tool.call": "permission-gate" },
      })
    } finally {
      await client.close()
      registry.shutdown()
    }
  })
})
