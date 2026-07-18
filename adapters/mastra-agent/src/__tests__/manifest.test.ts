import { describe, it, expect } from "vitest"
import { mastraAgent } from "../index.js"

describe("mastra-agent manifest options", () => {
  it("declares an `agent` option applied as `--agent <path>`", () => {
    const agentOpt = mastraAgent.options?.find((o) => o.id === "agent")
    expect(agentOpt).toBeDefined()
    expect(agentOpt!.type).toBe("string")
    // The daemon composes this into the spawn args, substituting {value}.
    expect(agentOpt!.bin_args_template).toEqual(["--agent", "{value}"])
  })

  it("still declares the `model` option", () => {
    const modelOpt = mastraAgent.options?.find((o) => o.id === "model")
    expect(modelOpt?.bin_args_template).toEqual(["--model", "{value}"])
  })
})
