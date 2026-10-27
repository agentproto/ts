import { describe, it, expect, vi, beforeEach } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import type { AgentCliClient, AgentCliDefinition } from "../types.js"

/**
 * Derived-from-model spawn guard.
 *
 * When the ACP server REJECTS the connect-time model apply, the session is
 * alive but on the agent's own DEFAULT model. For a free/fixed-routing
 * adapter that stays a warn-and-continue (agentproto#186). For a
 * `routeSelection:"derived-from-model"` adapter (opencode & co.) the model
 * id IS the route and the bill — observed live: opencode spawned with a
 * claude-code-style `…@openrouter` id silently ran (and billed)
 * anthropic/claude-sonnet-4-5. The spawn must refuse loudly instead.
 */

// A real EventEmitter (not a plain object) so `spawned.once("spawn"|"error", ...)`
// in define-agent-cli.ts's spawn guard works — emits "spawn" on the next
// microtask, mirroring a real ChildProcess's async success signal.
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(),
  })
  queueMicrotask(() => child.emit("spawn"))
  return child
}

let lastChild: ReturnType<typeof fakeChild> | undefined

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    lastChild = fakeChild()
    return lastChild
  }),
}))

// Mutable per-test fixtures the mocked ACP arm reads from.
let armModelApplyRejection: { requested: string; reason: string } | undefined
let closeCalls = 0
// Events yielded for a control turn (the "command" apply's `/model <id>`
// drain) — empty means the switch is never acknowledged.
let scriptedEvents: import("../types.js").StreamEvent[] = []

vi.mock("../protocol/acp-client.js", () => ({
  createAcpProtocolArm: vi.fn(() => {
    const arm: AgentCliClient = {
      sessionId: "acp-sess-1",
      get modelApplyRejection() {
        return armModelApplyRejection
      },
      async connect() {},
      async send() {},
      async *events() {
        for (const e of scriptedEvents) yield e
      },
      async cancel() {},
      async close() {
        closeCalls += 1
      },
    }
    return arm
  }),
}))

import { createAgentCliRuntime } from "../define-agent-cli.js"

const baseDef: AgentCliDefinition = {
  name: "fake-opencode",
  id: "fake-opencode",
  description: "fake",
  version: "0.1.0",
  bin: "fake-opencode",
  bin_args: ["acp"],
  install: [{ method: "brew", package: "fake" }],
  version_check: {
    cmd: "fake --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.1.0",
    timeout_ms: 5000,
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./fake-acp.ACP.md",
  options: [{ id: "model", type: "string" as const }],
} as AgentCliDefinition

const derivedDef: AgentCliDefinition = {
  ...baseDef,
  routeSelection: "derived-from-model",
  models: {
    default: "anthropic/claude-sonnet-4-5",
    allowed: [{ id: "openrouter/deepseek/deepseek-v4-pro", provider: "openrouter" }],
  },
} as AgentCliDefinition

describe("derived-from-model spawn guard (rejected model apply)", () => {
  beforeEach(() => {
    armModelApplyRejection = undefined
    closeCalls = 0
    lastChild = undefined
    scriptedEvents = []
  })

  it("refuses the spawn when a derived-from-model adapter rejects the requested model", async () => {
    armModelApplyRejection = {
      requested: "deepseek/deepseek-v4-pro@openrouter",
      reason: "Invalid value for config option model: deepseek/deepseek-v4-pro@openrouter",
    }
    const runtime = createAgentCliRuntime(derivedDef)

    await expect(
      runtime.start({
        cwd: "/tmp",
        config: { options: { model: "deepseek/deepseek-v4-pro@openrouter" } },
      }),
    ).rejects.toThrow(/refusing to start on the default model/)
  })

  it("names the requested id, the server reason, and a valid example in the error", async () => {
    armModelApplyRejection = {
      requested: "deepseek/deepseek-v4-pro@openrouter",
      reason: "Invalid value for config option model: deepseek/deepseek-v4-pro@openrouter",
    }
    const runtime = createAgentCliRuntime(derivedDef)

    const err = await runtime
      .start({
        cwd: "/tmp",
        config: { options: { model: "deepseek/deepseek-v4-pro@openrouter" } },
      })
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      )
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain("deepseek/deepseek-v4-pro@openrouter")
    expect(err!.message).toContain("Invalid value for config option model")
    // Actionable: points at the adapter's own menu shape, not a generic hint.
    expect(err!.message).toContain("openrouter/deepseek/deepseek-v4-pro")
  })

  it("tears down the arm and the child on refusal (no orphaned subprocess)", async () => {
    armModelApplyRejection = {
      requested: "bogus/model@openrouter",
      reason: "Invalid value",
    }
    const runtime = createAgentCliRuntime(derivedDef)

    await expect(
      runtime.start({ cwd: "/tmp", config: { options: { model: "bogus/model@openrouter" } } }),
    ).rejects.toThrow()
    expect(closeCalls).toBe(1)
    expect(lastChild?.kill).toHaveBeenCalledWith("SIGTERM")
  })

  it("keeps agentproto#186 warn-and-continue for adapters that are NOT derived-from-model", async () => {
    armModelApplyRejection = {
      requested: "claude-sonnet-4-6",
      reason: "Invalid value for config option model: claude-sonnet-4-6",
    }
    // baseDef has no routeSelection — the free/fixed-routing shape
    // (claude-code-style), where running on the default model is a tolerable
    // degradation, not a misroute.
    const runtime = createAgentCliRuntime(baseDef)

    const session = await runtime.start({
      cwd: "/tmp",
      config: { options: { model: "claude-sonnet-4-6" } },
    })
    expect(session.sessionId).toBe("acp-sess-1")
    await session.close()
  })

  it("does not fire when no model was explicitly requested", async () => {
    // A rejection can only exist when a model was requested; but even if an
    // arm reported one spuriously, the guard keys off the EXPLICIT request.
    armModelApplyRejection = {
      requested: "ghost",
      reason: "spurious",
    }
    const runtime = createAgentCliRuntime(derivedDef)

    const session = await runtime.start({ cwd: "/tmp" })
    expect(session.sessionId).toBe("acp-sess-1")
    await session.close()
  })

  it("does not fire when the model apply succeeded", async () => {
    armModelApplyRejection = undefined
    const runtime = createAgentCliRuntime(derivedDef)

    const session = await runtime.start({
      cwd: "/tmp",
      config: { options: { model: "openrouter/deepseek/deepseek-v4-pro" } },
    })
    expect(session.sessionId).toBe("acp-sess-1")
    await session.close()
  })
})

describe("derived-from-model spawn guard — apply:'command' (hermes-style)", () => {
  const commandDerivedDef: AgentCliDefinition = {
    ...derivedDef,
    name: "fake-hermes",
    bin: "fake-hermes",
    models: {
      ...derivedDef.models,
      apply: "command",
      allowed: [{ id: "deepseek/deepseek-v4@openrouter", provider: "openrouter" }],
    },
  } as AgentCliDefinition

  beforeEach(() => {
    armModelApplyRejection = undefined
    closeCalls = 0
    lastChild = undefined
    scriptedEvents = []
  })

  it("refuses the spawn when the /model control turn is never acknowledged", async () => {
    // Empty scripted events: the control turn drains with no "switched"
    // acknowledgement — previously the spawn-time call IGNORED
    // applyModelCommand's result and continued on the default model.
    scriptedEvents = [
      { kind: "turn-end", sessionId: "acp-sess-1", reason: "completed" },
    ] as import("../types.js").StreamEvent[]
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const runtime = createAgentCliRuntime(commandDerivedDef)

    await expect(
      runtime.start({ cwd: "/tmp", config: { options: { model: "bogus/model" } } }),
    ).rejects.toThrow(/refusing to start on the default model/)
    expect(closeCalls).toBe(1)
    expect(lastChild?.kill).toHaveBeenCalledWith("SIGTERM")
    warnSpy.mockRestore()
  })

  it("starts normally when the /model switch is acknowledged", async () => {
    scriptedEvents = [
      {
        kind: "text-delta",
        sessionId: "acp-sess-1",
        text: "Model switched to: deepseek/deepseek-v4 · Provider: openrouter",
      },
      { kind: "turn-end", sessionId: "acp-sess-1", reason: "completed" },
    ] as import("../types.js").StreamEvent[]
    const runtime = createAgentCliRuntime(commandDerivedDef)

    const session = await runtime.start({
      cwd: "/tmp",
      config: { options: { model: "deepseek/deepseek-v4@openrouter" } },
    })
    expect(session.sessionId).toBe("acp-sess-1")
    await session.close()
  })

  it("keeps warn-and-continue for a NON-derived command-apply adapter", async () => {
    const commandFreeDef: AgentCliDefinition = {
      ...baseDef,
      models: { apply: "command" },
    } as AgentCliDefinition
    scriptedEvents = [
      { kind: "turn-end", sessionId: "acp-sess-1", reason: "completed" },
    ] as import("../types.js").StreamEvent[]
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const runtime = createAgentCliRuntime(commandFreeDef)

    const session = await runtime.start({
      cwd: "/tmp",
      config: { options: { model: "whatever" } },
    })
    expect(session.sessionId).toBe("acp-sess-1")
    await session.close()
    warnSpy.mockRestore()
  })
})
