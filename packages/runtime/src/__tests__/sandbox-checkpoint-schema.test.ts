import { describe, it, expect } from "vitest"
import { agentStartInputSchema } from "../agent-start-schema.js"
import { agentprotoConfigSchema, findConfigKey } from "../config-schema.js"

const parseSpawn = (sandboxCheckpoint: unknown) =>
  agentStartInputSchema.safeParse({ adapter: "claude-code", prompt: "hi", sandboxCheckpoint })

describe("agent_start.sandboxCheckpoint", () => {
  it("accepts false, its JSON-string form, and a partial object", () => {
    expect(parseSpawn(false)).toMatchObject({ success: true, data: { sandboxCheckpoint: false } })
    expect(parseSpawn("false")).toMatchObject({ success: true, data: { sandboxCheckpoint: false } })
    expect(parseSpawn({ on: ["teardown"], minIntervalMs: 0, refPrefix: "safety/" })).toMatchObject({
      success: true,
      data: { sandboxCheckpoint: { on: ["teardown"], minIntervalMs: 0, refPrefix: "safety/" } },
    })
    expect(parseSpawn(undefined).success).toBe(true)
  })

  it("rejects true, unknown keys, unknown triggers and unsafe ref prefixes", () => {
    expect(parseSpawn(true).success).toBe(false)
    expect(parseSpawn({ enable: true }).success).toBe(false)
    expect(parseSpawn({ on: ["turn-start"] }).success).toBe(false)
    expect(parseSpawn({ refPrefix: "a b/" }).success).toBe(false)
    expect(parseSpawn({ refPrefix: "a/../b/" }).success).toBe(false)
    expect(parseSpawn({ refPrefix: "$(x)/" }).success).toBe(false)
    expect(parseSpawn({ timeoutMs: 0 }).success).toBe(false)
  })
})

describe("defaults.sandbox.checkpoint config", () => {
  const parseConfig = (checkpoint: unknown) =>
    agentprotoConfigSchema.safeParse({ version: 1, defaults: { sandbox: { checkpoint } } })

  it("validates the block and each declared key path", () => {
    expect(parseConfig({ enabled: false, on: ["turn-end"], refPrefix: "safety/", minIntervalMs: 60_000, timeoutMs: 30_000 }).success).toBe(true)
    expect(parseConfig({ on: ["nope"] }).success).toBe(false)
    expect(parseConfig({ refPrefix: "-x" }).success).toBe(false)
    for (const key of ["enabled", "on", "refPrefix", "minIntervalMs", "timeoutMs"]) {
      expect(findConfigKey(`defaults.sandbox.checkpoint.${key}`)?.writable).toBe(true)
    }
  })
})
