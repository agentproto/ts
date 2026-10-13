/**
 * `agentproto sessions start --turn-retry <spec>` — client-side parsing of
 * the CLI twin of `agent_start.turnRetry`. The daemon fills the numeric
 * defaults; the CLI only rejects what can never validate.
 */

import { describe, it, expect } from "vitest"
import { parseTurnRetryFlag } from "../commands/sessions.js"

describe("parseTurnRetryFlag", () => {
  it("expands 'all'", () => {
    expect(parseTurnRetryFlag("all")).toEqual({ on: ["rate-limit", "upstream-5xx", "no-output-stall"] })
  })
  it("accepts a comma list of classes", () => {
    expect(parseTurnRetryFlag("rate-limit, no-output-stall")).toEqual({ on: ["rate-limit", "no-output-stall"] })
  })
  it("passes a JSON object through", () => {
    expect(parseTurnRetryFlag('{"on":["upstream-5xx"],"maxRetries":2,"retryAfterToolCalls":true}')).toEqual({
      on: ["upstream-5xx"],
      maxRetries: 2,
      retryAfterToolCalls: true,
    })
  })
  it("accepts the daemon schema's bounds", () => {
    expect(parseTurnRetryFlag('{"on":["rate-limit"],"maxRetries":1}')).toEqual({ on: ["rate-limit"], maxRetries: 1 })
    expect(parseTurnRetryFlag('{"on":["rate-limit"],"baseDelayMs":0,"maxDelayMs":60000,"factor":1}')).toEqual({
      on: ["rate-limit"],
      baseDelayMs: 0,
      maxDelayMs: 60000,
      factor: 1,
    })
  })
  it("passes a rotate list through", () => {
    const raw = '{"on":["rate-limit"],"rotate":[{"model":"opencode/big-pickle"},{"model":"x","profileRef":"p"}],"rotateOn":["rate-limit"],"cooldownMs":1000}'
    expect(parseTurnRetryFlag(raw)).toEqual(JSON.parse(raw))
  })
  it.each([
    ['{"on":["rate-limit"],"rotate":"big-pickle"}', '"rotate" must be an array'],
    ['{"on":["rate-limit"],"rotate":[{"profileRef":"p"}]}', '"rotate" must be an array'],
    ['{"on":["rate-limit"],"rotateOn":["crashed"]}', '"rotateOn"'],
    ['{"on":["rate-limit"],"cooldownMs":0}', '"cooldownMs"'],
  ])("rejects bad rotation %s", (raw, fragment) => {
    expect(parseTurnRetryFlag(raw)).toContain(fragment)
  })
  it.each([
    ["crashed", "unknown class"],
    ["", "must list"],
    ["{nope", "bad JSON"],
    ['{"on":["rate-limit"],"maxRetries":-1}', "maxRetries"],
    ['{"on":["rate-limit"],"maxRetries":0}', '"maxRetries" must be a positive integer'],
    ['{"on":["rate-limit"],"maxRetries":2.5}', '"maxRetries" must be a positive integer'],
    ['{"on":["rate-limit"],"baseDelayMs":10.5}', '"baseDelayMs" must be a non-negative integer'],
    ['{"on":["rate-limit"],"maxDelayMs":-1}', '"maxDelayMs" must be a non-negative integer'],
    ['{"on":["rate-limit"],"factor":0.5}', '"factor" must be a number >= 1'],
    ['{"on":["rate-limit"],"retryAfterToolCalls":"yes"}', "retryAfterToolCalls"],
  ])("rejects %s", (raw, fragment) => {
    const out = parseTurnRetryFlag(raw)
    expect(typeof out).toBe("string")
    expect(out).toContain(fragment)
  })
})
