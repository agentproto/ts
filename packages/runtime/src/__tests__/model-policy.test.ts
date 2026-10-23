/**
 * `checkModelPolicy` - the one generic model rule. Policies refer to model-list
 * ids only; nothing in the check knows about price.
 */

import { describe, expect, it } from "vitest"
import type { ModelList, ModelListSource } from "@agentproto/model-catalog/lists"

import { checkModelPolicy, modelPolicyInputSchema, normalizeModelPolicy } from "../model-policy.js"
import { agentStartInputSchema } from "../agent-start-schema.js"
import { spawnAgentSession } from "../session-spawn.js"
import { createSessionsRegistry } from "../sessions.js"

const LISTS: Record<string, ModelList> = {
  cheap: { id: "cheap", ids: ["opencode/glm-5.3-flash-free", "acme/small"] },
  pricey: { id: "pricey", ids: ["acme/large"] },
  mixed: { id: "mixed", ids: ["acme/small", "acme/large"] },
}
const src: ModelListSource = { get: id => LISTS[id] }

describe("checkModelPolicy", () => {
  it("no policy permits everything", () => {
    expect(checkModelPolicy("anything/at-all", undefined, src)).toEqual({ ok: true })
    expect(checkModelPolicy("anything/at-all", {}, src)).toEqual({ ok: true })
  })

  it("block refuses a model in a blocked list", () => {
    const v = checkModelPolicy("acme/large", { block: ["pricey"] }, src)
    expect(v).toMatchObject({ ok: false, code: "model_blocked" })
    expect(checkModelPolicy("acme/small", { block: ["pricey"] }, src)).toEqual({ ok: true })
  })

  it("block always wins over allow", () => {
    const v = checkModelPolicy("acme/large", { allow: ["mixed"], block: ["pricey"] }, src)
    expect(v).toMatchObject({ ok: false, code: "model_blocked" })
    expect(checkModelPolicy("acme/small", { allow: ["mixed"], block: ["pricey"] }, src)).toEqual({ ok: true })
  })

  it("allow refuses anything outside every allowed list, uncataloged ids included", () => {
    expect(checkModelPolicy("acme/large", { allow: ["cheap"] }, src)).toMatchObject({
      ok: false,
      code: "model_not_allowed",
    })
    expect(checkModelPolicy("never/heard-of-it", { allow: ["cheap"] }, src)).toMatchObject({
      ok: false,
      code: "model_not_allowed",
    })
    expect(checkModelPolicy("acme/small", { allow: ["cheap", "pricey"] }, src)).toEqual({ ok: true })
    expect(checkModelPolicy("acme/large", { allow: ["cheap", "pricey"] }, src)).toEqual({ ok: true })
  })

  it("an empty allow list permits nothing", () => {
    expect(checkModelPolicy("acme/small", { allow: [] }, src)).toMatchObject({
      ok: false,
      code: "model_not_allowed",
    })
  })

  it("an unknown list id is a refusal, in block and in allow", () => {
    expect(checkModelPolicy("acme/small", { block: ["nope"] }, src)).toMatchObject({
      ok: false,
      code: "unknown_list",
    })
    expect(checkModelPolicy("acme/small", { allow: ["nope"] }, src)).toMatchObject({
      ok: false,
      code: "unknown_list",
    })
    expect(checkModelPolicy("acme/small", { allow: ["cheap"], block: ["nope"] }, src)).toMatchObject({
      ok: false,
      code: "unknown_list",
    })
  })
})

describe("normalizeModelPolicy", () => {
  it("dedupes, keeps an empty allow, and drops non-policies", () => {
    expect(normalizeModelPolicy({ allow: ["a", "a"], block: ["b"] })).toEqual({ allow: ["a"], block: ["b"] })
    expect(normalizeModelPolicy({ allow: [] })).toEqual({ allow: [] })
    expect(normalizeModelPolicy({})).toBeUndefined()
    expect(normalizeModelPolicy("zero-cost")).toBeUndefined()
    expect(normalizeModelPolicy(undefined)).toBeUndefined()
  })
})

describe("spawnAgentSession enforces the policy on every merge layer", () => {
  function deps() {
    const registry = createSessionsRegistry({ persist: false })
    let started = 0
    return {
      registry,
      started: () => started,
      deps: {
        registry,
        resolveAgentAdapter: async () => ({
          commandPreview: "mock",
          startSession: async () => {
            started++
            return {
              sessionId: "s",
              async *send() {
                yield { kind: "turn-end" as const, reason: "completed" as const }
              },
              async cancel() {},
              async close() {},
            }
          },
        }),
        loadDefaultsConfig: async () => undefined,
      },
    }
  }

  it("an explicit model cannot escape a block", async () => {
    const d = deps()
    const result = await spawnAgentSession(d.deps as never, {
      adapter: "opencode",
      cwd: "/tmp",
      model: "opencode/glm-5.3-flash-free",
      modelPolicy: { block: ["default-rotation"] },
    } as never)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("model_policy_refused")
    expect(d.started()).toBe(0)
  })

  it("allow refuses an uncataloged id", async () => {
    const d = deps()
    const result = await spawnAgentSession(d.deps as never, {
      adapter: "opencode",
      cwd: "/tmp",
      model: "opencode/not-a-cataloged-model",
      modelPolicy: { allow: ["default-rotation"] },
    } as never)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("model_policy_refused")
  })

  it("an unknown list is refused at spawn", async () => {
    const d = deps()
    const result = await spawnAgentSession(d.deps as never, {
      adapter: "opencode",
      cwd: "/tmp",
      model: "opencode/glm-5.3-flash-free",
      modelPolicy: { allow: ["no-such-list"] },
    } as never)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("model_policy_refused")
    expect(result.details).toMatchObject({ policyCode: "unknown_list" })
  })

  it("a permitted model spawns and the policy is stored on the descriptor", async () => {
    const d = deps()
    const result = await spawnAgentSession(d.deps as never, {
      adapter: "opencode",
      cwd: "/tmp",
      model: "opencode/glm-5.3-flash-free",
      modelPolicy: { allow: ["default-rotation"] },
    } as never)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.modelPolicy).toEqual({ allow: ["default-rotation"] })
  })
})

describe("modelPolicy input is strict (a typo must not become no restriction)", () => {
  it("modelPolicyInputSchema rejects unknown keys and wrong shapes", () => {
    expect(modelPolicyInputSchema.safeParse({ allows: ["x"] }).success).toBe(false)
    expect(modelPolicyInputSchema.safeParse({ allow: ["x"], blok: ["y"] }).success).toBe(false)
    expect(modelPolicyInputSchema.safeParse({ allow: "x" }).success).toBe(false)
    expect(modelPolicyInputSchema.safeParse({ allow: ["x"], block: ["y"] }).success).toBe(true)
  })

  it("agent_start's modelPolicy field rejects {allows:[...]} instead of dropping it", () => {
    const base = { adapter: "opencode", cwd: "/tmp" }
    expect(agentStartInputSchema.safeParse({ ...base, modelPolicy: { allows: ["x"] } }).success).toBe(false)
    expect(agentStartInputSchema.safeParse({ ...base, modelPolicy: JSON.stringify({ allows: ["x"] }) }).success).toBe(false)
    expect(agentStartInputSchema.safeParse({ ...base, modelPolicy: { allow: ["x"] } }).success).toBe(true)
  })
})
