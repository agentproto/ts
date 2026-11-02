import { describe, it, expect } from "vitest"
import {
  MAX_PLACEMENT_RUNGS,
  bootErrorClass,
  formatPlacementAttempts,
  placementInputSchema,
  placementRungProblem,
  resolveLadder,
  rungOverrides,
  walkPlacementLadder,
  type PlacementRung,
} from "../placement-ladder.js"

const ladder: PlacementRung[] = [{ sandbox: "a", model: "m1" }, { sandbox: "b" }, { sandbox: "c" }]
const fail = (code: string, details?: Record<string, unknown>) =>
  ({ ok: false as const, code, message: `${code} msg`, ...(details ? { details } : {}) })

describe("placementInputSchema", () => {
  it("accepts a ladder of rungs with the optional axes", () => {
    const parsed = placementInputSchema.parse({
      ladder: [{ sandbox: "e2b", model: "m", access: { profileRef: "p" }, preflight: ["model-answers"], turnRetry: { on: ["rate-limit"] } }],
    })
    expect(parsed.ladder).toHaveLength(1)
  })

  it.each([
    ["empty", { ladder: [] }],
    ["too long", { ladder: Array.from({ length: MAX_PLACEMENT_RUNGS + 1 }, () => ({ sandbox: "a" })) }],
    ["rung without sandbox", { ladder: [{ model: "m" }] }],
    ["unknown rung key", { ladder: [{ sandbox: "a", nope: 1 }] }],
    ["unknown top-level key", { ladder: [{ sandbox: "a" }], nope: 1 }],
  ])("rejects %s", (_name, input) => {
    expect(placementInputSchema.safeParse(input).success).toBe(false)
  })
})

describe("walkPlacementLadder", () => {
  it("returns the first rung that places, without running later ones", async () => {
    const seen: number[] = []
    const walk = await walkPlacementLadder(ladder, async (_r, i) => {
      seen.push(i)
      return i === 0 ? fail("sandbox_preflight_failed", { errorClass: "usage-limit", egressIp: "1.2.3.4" }) : { ok: true, value: i }
    })
    expect(seen).toEqual([0, 1])
    expect(walk).toMatchObject({ ok: true, rung: 1, value: 1 })
    if (!walk.ok) return
    expect(walk.attempts).toMatchObject([
      { rung: 0, provider: "a", model: "m1", outcome: "failed", errorClass: "usage-limit", egressIp: "1.2.3.4" },
      { rung: 1, provider: "b", outcome: "ok" },
    ])
  })

  it("stops on a failure that is not a placement problem", async () => {
    const seen: number[] = []
    const walk = await walkPlacementLadder(ladder, async (_r, i) => {
      seen.push(i)
      return fail("sandbox_cwd_invalid")
    })
    expect(seen).toEqual([0])
    expect(walk).toMatchObject({ ok: false, exhausted: false, failure: { code: "sandbox_cwd_invalid" } })
  })

  it("reports exhaustion with every attempt when all rungs are skipped", async () => {
    const walk = await walkPlacementLadder(ladder, async () => fail("sandbox_boot_failed", { errorClass: "sandbox_capacity" }))
    expect(walk.ok).toBe(false)
    if (walk.ok) return
    expect(walk.exhausted).toBe(true)
    expect(walk.attempts.map(a => a.errorClass)).toEqual(["sandbox_capacity", "sandbox_capacity", "sandbox_capacity"])
  })

  it.each([
    "sandbox_preflight_failed",
    "sandbox_boot_failed",
    "sandbox_overflow_refused",
    "sandbox_egress_pool_exhausted",
    "sandbox_egress_all_cooling",
    "sandbox_provider_not_found",
    "device_offline",
  ])("advances on %s", async code => {
    const walk = await walkPlacementLadder([{ sandbox: "a" }, { sandbox: "b" }], async (_r, i) => (i === 0 ? fail(code) : { ok: true, value: "x" }))
    expect(walk.ok).toBe(true)
  })

  it.each(["sandbox_boot_cancelled", "sandbox_preflight_invalid", "sandbox_reuse_ambiguous", "cloud_spawn_refused", "adapter_not_found"])(
    "does not advance on %s",
    async code => {
      const walk = await walkPlacementLadder([{ sandbox: "a" }, { sandbox: "b" }], async () => fail(code))
      expect(walk).toMatchObject({ ok: false, exhausted: false })
    },
  )

  it("measures each attempt's duration", async () => {
    let t = 100
    const walk = await walkPlacementLadder([{ sandbox: "a" }], async () => ({ ok: true, value: 1 }), () => (t += 25))
    if (!walk.ok) throw new Error("unreachable")
    expect(walk.attempts[0]?.durationMs).toBe(25)
  })
})

describe("helpers", () => {
  it("bootErrorClass reads only a typed sandbox_* code", () => {
    expect(bootErrorClass(Object.assign(new Error("x"), { code: "sandbox_capacity" }))).toBe("sandbox_capacity")
    expect(bootErrorClass(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBeUndefined()
    expect(bootErrorClass(new Error("sandbox_capacity in the text"))).toBeUndefined()
    expect(bootErrorClass("sandbox_capacity")).toBeUndefined()
  })

  it("resolveLadder fills only the axes a rung omits", () => {
    const out = resolveLadder([{ sandbox: "a" }, { sandbox: "b", model: "own", preflight: [] }], {
      model: "top",
      preflight: ["model-answers"],
      access: { profileRef: "p" },
    })
    expect(out[0]).toEqual({ sandbox: "a", model: "top", preflight: ["model-answers"], access: { profileRef: "p" } })
    expect(out[1]).toMatchObject({ model: "own", preflight: [] })
  })

  it("rungOverrides carries only the axes the rung sets", () => {
    expect(rungOverrides({ sandbox: "a" })).toEqual({ sandbox: "a" })
    expect(rungOverrides({ sandbox: "a", model: "m" })).toEqual({ sandbox: "a", model: "m" })
  })

  it("refuses a reuse rung", () => {
    expect(placementRungProblem({ sandbox: { provider: "e2b", config: {}, reuse: "sbx" } } as PlacementRung, 2)).toContain("ladder[2]")
    expect(placementRungProblem({ sandbox: "e2b" }, 0)).toBeUndefined()
  })

  it("formats attempts for the exhausted message", () => {
    expect(
      formatPlacementAttempts([
        { rung: 0, provider: "a", model: "m", outcome: "failed", errorClass: "usage-limit", egressIp: "1.1.1.1", durationMs: 1 },
        { rung: 1, provider: "b", outcome: "ok", durationMs: 1 },
      ]),
    ).toBe("#1 a m: failed usage-limit (egress 1.1.1.1); #2 b: ok")
  })
})
