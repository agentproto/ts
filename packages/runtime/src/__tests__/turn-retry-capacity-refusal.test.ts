/**
 * An upstream "at capacity" refusal is a transient server-side error, not a
 * bad request. Observed 2026-10-29 on an opencode executor
 * (`opencode-go/deepseek-v4.1-flash`): five turns in a row failed on the
 * exact message below, each logged `[turn-retry] not retrying: not a
 * transient provider error` and then an empty-turn warning blaming the
 * model id. The refusal names its own retry delay, which the backoff honours.
 */

import { describe, it, expect } from "vitest"
import type { SessionDescriptor } from "../sessions.js"
import {
  classifyTurnError,
  decideTurnRetry,
  emptyTurnWarningLine,
  extractRetryAfterMs,
} from "../turn-retry.js"
import { resolveTurnRetryPolicy } from "../turn-retry-policy.js"

const CAPACITY_REFUSAL =
  "AI_APICallError: Upstream request failed: [ttft_admission_refused] the cell is at capacity; retry shortly (after 8 s)"
const INVALID_MODEL = "AI_APICallError: Model not found: opencode-go/deepseek-v9-nope"

const policy = resolveTurnRetryPolicy({ on: ["rate-limit", "upstream-5xx", "no-output-stall"] })
const desc = { id: "s", kind: "agent-cli", status: "running", turnRetry: policy } as SessionDescriptor
const errEnd = (error: string) => ({ kind: "turn-end" as const, reason: "error", error })

describe("capacity refusal → transient, delay from its own hint", () => {
  it("classifies the observed refusal as a transient upstream error", () => {
    expect(classifyTurnError(CAPACITY_REFUSAL)).toBe("upstream-5xx")
  })

  it.each([
    "[ttft_admission_refused] request refused",
    "the cell is at capacity",
    "server at capacity, retry shortly",
  ])("%s → upstream-5xx", message => {
    expect(classifyTurnError(message)).toBe("upstream-5xx")
  })

  it("reads the '(after 8 s)' hint", () => {
    expect(extractRetryAfterMs(CAPACITY_REFUSAL)).toBe(8_000)
  })

  it("retries the refusal after the hinted delay", () => {
    expect(decideTurnRetry(desc, errEnd(CAPACITY_REFUSAL))).toMatchObject({
      action: "retry",
      errorClass: "upstream-5xx",
      attempt: 1,
      delayMs: 8_000,
    })
  })

  it("caps a large hint at maxDelayMs", () => {
    const long = CAPACITY_REFUSAL.replace("after 8 s", "after 900 s")
    expect(decideTurnRetry(desc, errEnd(long))).toMatchObject({ action: "retry", delayMs: policy.maxDelayMs })
  })

  it("keeps a real invalid-model error non-transient", () => {
    expect(classifyTurnError(INVALID_MODEL)).toBe("other")
    expect(decideTurnRetry(desc, errEnd(INVALID_MODEL))).toMatchObject({
      action: "skip",
      skipReason: "not a transient provider error",
    })
  })
})

describe("emptyTurnWarningLine", () => {
  it("names the transient provider error instead of the model id", () => {
    const line = emptyTurnWarningLine({ costUsd: 0, errorMessage: CAPACITY_REFUSAL })
    expect(line).toContain("[warning] empty turn")
    expect(line).toContain("ttft_admission_refused")
    expect(line).toContain("transient")
    expect(line).not.toContain("invalid model id")
  })

  it("names a non-transient provider error without guessing the model id", () => {
    const line = emptyTurnWarningLine({ errorMessage: "context length exceeded" })
    expect(line).toContain("context length exceeded")
    expect(line).not.toContain("invalid model id")
  })

  it("keeps the model-id hint for a turn that ended with no error", () => {
    const line = emptyTurnWarningLine({ costUsd: 0 })
    expect(line).toContain("Likely an invalid model id")
    expect(line).toContain("cost $0")
  })
})
