/**
 * `planReachRoute`: the daemon builds the owner's route once and starts the
 * router only when at least one adapter can deliver. A telegram-only route on
 * a daemon without Telegram approval cards starts nothing and says why.
 */

import { describe, expect, it } from "vitest"

import { planReachRoute } from "../reach/index.js"

const SECRET = "whsec_" + Buffer.alloc(32, 3).toString("base64")
const webhook = { id: "pygmalion", kind: "webhook", url: "https://receiver.invalid/api/reach", secret: SECRET }
const floor = { id: "floor", kind: "telegram" }
const bridge = { announce: async () => ({ posted: true as const }) }

describe("planReachRoute", () => {
  it("a telegram-only route with no bridge (telegramApprovalCards off) is off, with one reach: warning", () => {
    const plan = planReachRoute([floor], { telegramBridge: () => undefined, telegramAvailable: false })
    expect(plan.on).toBe(false)
    expect(plan.unservable).toEqual([{ index: 0, id: "floor", reason: "telegram-not-configured" }])
    expect(plan.warnings).toEqual([
      "reach: routes.owner has no adapter that can deliver (floor: telegram-not-configured); router not started, approvals are announced as without reach",
    ])
  })

  it("a telegram entry for another alias cannot deliver either", () => {
    const plan = planReachRoute([{ ...floor, alias: "other" }], { telegramBridge: bridge, telegramAlias: "default" })
    expect(plan.on).toBe(false)
    expect(plan.unservable).toEqual([{ index: 0, id: "floor", reason: "alias-not-configured" }])
  })

  it("is on with a telegram entry the bridge serves, built before the bridge exists", async () => {
    let late: typeof bridge | undefined
    const plan = planReachRoute([floor], { telegramBridge: () => late, telegramAvailable: true })
    expect(plan.on).toBe(true)
    expect(plan.warnings).toEqual([])
    late = bridge
    const receipt = await plan.adapters[0]!.send({
      summary: "s",
      intent: "ask",
      to: "owner",
      urgency: "normal",
      dedupeKey: "approval:apr_1",
      source: { kind: "k" },
      ask: { ref: "apr_1", options: ["approve", "deny"] },
    })
    expect(receipt.status).toBe("delivered")
  })

  it("is on with a webhook even when the telegram floor cannot serve", () => {
    const plan = planReachRoute([webhook, floor], { telegramAvailable: false })
    expect(plan.on).toBe(true)
    expect(plan.adapters.map(a => a.id)).toEqual(["pygmalion", "floor"])
    expect(plan.warnings).toEqual([])
  })

  it("no entries: off and silent; only bad entries: off, each named, nothing secret", () => {
    expect(planReachRoute([])).toMatchObject({ on: false, warnings: [] })
    const plan = planReachRoute([{ id: "p", kind: "webhook", url: "https://r.invalid/x", secret: "plain" }])
    expect(plan.on).toBe(false)
    expect(plan.warnings).toEqual([
      "reach: route entry p skipped (invalid-secret)",
      "reach: routes.owner has no adapter that can deliver (no usable entry); router not started, approvals are announced as without reach",
    ])
    expect(plan.warnings.join(" ")).not.toContain("r.invalid")
  })
})
