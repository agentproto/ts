import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  createAgent,
  defineAgent,
  defineTool,
  implementTool,
  loadAgent,
  runTool,
} from "../index.js"
import type {
  AgentHandle,
  ToolDefinition,
  ToolHandle,
  ToolImplementation,
} from "../index.js"

describe("@agentproto/sdk root exports", () => {
  it("re-exports the authoring primitives", () => {
    expect(typeof defineTool).toBe("function")
    expect(typeof implementTool).toBe("function")
    expect(typeof runTool).toBe("function")
    expect(typeof defineAgent).toBe("function")
    expect(typeof loadAgent).toBe("function")
    expect(typeof createAgent).toBe("function")
  })

  it("keeps the AIP-14 contract type connected", () => {
    const handle: ToolHandle<{ city: string }> = defineTool({
      id: "lookup",
      description: "Look up a city.",
      inputSchema: z.object({ city: z.string() }),
    })
    const definition: ToolDefinition<{ city: string }> = {
      id: "lookup",
      description: "Look up a city.",
      inputSchema: z.object({ city: z.string() }),
    }
    const implementation: ToolImplementation<{ city: string }> = implementTool(
      handle,
      async () => ({ ok: true }),
    )
    const agentHandle: AgentHandle = defineAgent({
      schema: "agent/v1",
      id: "looker-upper",
      description: "Looks things up.",
      model: "test/model",
    })

    expect(definition.id).toBe("lookup")
    expect(implementation.tool.id).toBe("lookup")
    expect(agentHandle.id).toBe("looker-upper")
  })
})
