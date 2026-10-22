/**
 * The daemon's per-session CONFIG read-surface: a live agent-cli session's
 * advertised ACP config options (the `session/new` response's `configOptions`)
 * are stamped onto the descriptor at read time (list()/get()), so
 * `GET /sessions` and `GET /sessions/:id` carry them. This is the server half
 * of the VS Code model picker's hot switch: the `model` option lists the
 * values the RUNNING agent accepts for its model config option, and a value
 * outside it is rejected outright ("Invalid value for config option model").
 * Coverage: presence for a live ACP arm, absence for an arm with no config
 * registry, and the never-persisted (read-time-only) contract.
 */

import { describe, it, expect } from "vitest"

import type { SessionConfigOption } from "@agentproto/acp/client"

import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"

let n = 0

function fakeAgentSession(
  configOptions?: readonly SessionConfigOption[],
): AgentSessionLike {
  return {
    sessionId: `c_${n++}`,
    ...(configOptions ? { availableConfigOptions: configOptions } : {}),
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function reg() {
  return createSessionsRegistry({ sessionEvents: createSessionEventBus(), persist: false })
}

function spawnLive(
  registry: ReturnType<typeof reg>,
  agentSession: AgentSessionLike,
): string {
  return registry.spawnAgent({
    workspaceSlug: "default",
    cwd: process.cwd(),
    adapterSlug: "claude-code",
    agentSession,
  }).id
}

const MODEL_OPTION: SessionConfigOption = {
  id: "model",
  name: "Model",
  type: "select",
  currentValue: "claude-sonnet-5-5",
  options: [
    { value: "claude-sonnet-5-5", name: "Sonnet 5.5" },
    { value: "claude-opus-5-5", name: "Opus 5.5" },
  ],
}

describe("session read-surface -- live ACP config options", () => {
  it("stamps configOptions on get() and list()", () => {
    const registry = reg()
    const id = spawnLive(registry, fakeAgentSession([MODEL_OPTION]))
    try {
      const got = registry.get(id)
      expect(got?.configOptions?.map(o => o.id)).toEqual(["model"])

      const listed = registry.list().find(s => s.id === id)
      expect(listed?.configOptions?.map(o => o.id)).toEqual(["model"])
    } finally {
      registry.shutdown()
    }
  })

  it("omits the field for an arm with no config registry", () => {
    const registry = reg()
    const id = spawnLive(registry, fakeAgentSession())
    try {
      expect(registry.get(id)?.configOptions).toBeUndefined()
    } finally {
      registry.shutdown()
    }
  })
})

/** A driver session that records the exact model id the daemon hands it --
 *  the wire value the agent will be asked to accept. */
function recordingAgentSession(
  configOptions?: readonly SessionConfigOption[],
): AgentSessionLike & { lastSetModel?: string } {
  const session: AgentSessionLike & { lastSetModel?: string } = {
    sessionId: "recording-session",
    ...(configOptions ? { availableConfigOptions: configOptions } : {}),
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
    async setModel(modelId: string) {
      session.lastSetModel = modelId
      return { applied: true, model: modelId }
    },
  }
  return session
}

describe("setModel -- the live agent's own vocabulary", () => {
  it("sends an ADVERTISED value verbatim (no catalog wire normalization)", async () => {
    const registry = reg()
    const agentSession = recordingAgentSession([
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "anthropic/claude-sonnet-5-5",
        options: [{ value: "anthropic/claude-sonnet-5-5", name: "Sonnet 5.5" }],
      },
    ])
    const id = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      adapterSlug: "claude-code",
      agentSession,
      // A fixed native adapter: the catalog wire normalization would BARE the
      // vendor prefix ("anthropic/…" → "…"), which is NOT the value the
      // agent advertised (and the one it validates against).
      routeSelection: "free",
      adapterProvider: "anthropic",
    }).id
    try {
      const result = await registry.setModel(id, "anthropic/claude-sonnet-5-5")
      expect(result.applied).toBe(true)
      expect(agentSession.lastSetModel).toBe("anthropic/claude-sonnet-5-5")
    } finally {
      registry.shutdown()
    }
  })

  it("still normalizes a value the agent did NOT advertise", async () => {
    const registry = reg()
    const agentSession = recordingAgentSession([
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "claude-sonnet-5-5",
        options: [{ value: "claude-sonnet-5-5", name: "Sonnet 5.5" }],
      },
    ])
    const id = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      adapterSlug: "claude-code",
      agentSession,
      routeSelection: "free",
      adapterProvider: "anthropic",
    }).id
    try {
      await registry.setModel(id, "anthropic/claude-opus-5-5")
      expect(agentSession.lastSetModel).toBe("claude-opus-5-5")
    } finally {
      registry.shutdown()
    }
  })
})
