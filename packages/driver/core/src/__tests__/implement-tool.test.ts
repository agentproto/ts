/**
 * Tests for `implementTool` + `defineDriver({ implementations[] })`.
 *
 * Covers:
 * - Typed binding (compile-time type-flow from contract → body)
 * - Runtime merge of `implementations[]` into the execute map
 * - Coexistence of `execute` (legacy) and `implementations` (typed)
 * - Collision rejection when both forms supply different bodies for
 *   the same tool id.
 */

import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver } from "../define-provider.js"
import { implementTool } from "../implement-tool.js"

const echoTool = defineTool({
  id: "echo",
  description: "Echoes input back as output.",
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
})

const upperTool = defineTool({
  id: "upper",
  description: "Uppercases its input.",
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ shouted: z.string() }),
})

describe("implementTool", () => {
  it("returns a frozen (tool, body) pair carrying the contract handle", () => {
    const echoImpl = implementTool(echoTool, async ({ input }) => ({
      echoed: input.message,
    }))
    expect(echoImpl.tool).toBe(echoTool)
    expect(typeof echoImpl.body).toBe("function")
    expect(Object.isFrozen(echoImpl)).toBe(true)
  })
})

describe("defineDriver({ implementations[] }) typed path", () => {
  it("derives the execute map from implementations[].tool.id", () => {
    const echoImpl = implementTool(echoTool, async ({ input }) => ({
      echoed: input.message,
    }))
    const upperImpl = implementTool(upperTool, async ({ input }) => ({
      shouted: input.message.toUpperCase(),
    }))

    const provider = defineDriver({
      id: "echo-upper-builtin",
      name: "Echo + Upper",
      description: "Two trivial implementations bound via implementTool.",
      kind: "builtin",
      implements: [
        { tool: "echo", version: "1.0.0" },
        { tool: "upper", version: "1.0.0" },
      ],
      implementations: [echoImpl, upperImpl],
    })

    expect(provider.execute).toHaveProperty("echo")
    expect(provider.execute).toHaveProperty("upper")
    expect(Object.keys(provider.execute).sort()).toEqual(["echo", "upper"])
  })

  it("dispatches via the typed body", async () => {
    const upperImpl = implementTool(upperTool, async ({ input }) => ({
      shouted: input.message.toUpperCase(),
    }))
    const provider = defineDriver({
      id: "upper-builtin",
      name: "Upper",
      description: "test",
      kind: "builtin",
      implements: [{ tool: "upper", version: "1.0.0" }],
      implementations: [upperImpl],
    })

    const result = await provider.execute["upper"]!({
      input: { message: "hi" },
      context: {},
      driverCtx: {
        secrets: {},
        authState: "authed",
        providerId: "upper-builtin",
        driverKind: "builtin",
        implementsEntry: { tool: "upper", version: "1.0.0" },
      },
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ shouted: "HI" })
  })
})

describe("defineDriver — coexistence of execute + implementations", () => {
  it("merges both forms when keys are disjoint", () => {
    const echoImpl = implementTool(echoTool, async ({ input }) => ({
      echoed: input.message,
    }))
    const provider = defineDriver({
      id: "mixed",
      name: "Mixed",
      description: "test",
      kind: "builtin",
      implements: [
        { tool: "echo", version: "1.0.0" },
        { tool: "upper", version: "1.0.0" },
      ],
      execute: {
        upper: async () => ({ shouted: "X" }),
      },
      implementations: [echoImpl],
    })
    expect(Object.keys(provider.execute).sort()).toEqual(["echo", "upper"])
  })

  it("rejects ambiguous duplicate body on the same tool id", () => {
    const echoImpl = implementTool(echoTool, async ({ input }) => ({
      echoed: input.message,
    }))
    expect(() =>
      defineDriver({
        id: "ambig",
        name: "Ambig",
        description: "test",
        kind: "builtin",
        implements: [{ tool: "echo", version: "1.0.0" }],
        execute: { echo: async () => ({ echoed: "from-bag" }) },
        implementations: [echoImpl],
      })
    ).toThrow(/duplicate body for 'echo'/)
  })
})
