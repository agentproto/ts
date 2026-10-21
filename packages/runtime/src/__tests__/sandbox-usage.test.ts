/**
 * The remote-usage projection (`sandbox-usage.ts`'s `projectRemoteUsage`).
 *
 * A sandboxed session runs inside a box with its own daemon, so its usage
 * is read back over the wire: the box's `session_usage` answer is projected
 * onto the HOST descriptor. That answer carries the cache split
 * (`cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens`) — the
 * projection used to drop it, so a sandboxed session showed input/output
 * tokens but no cache split at all: a half-usage row that reads as
 * "measured" while the cache half is missing.
 *
 * These tests pin both halves of the rule: the split is forwarded when the
 * remote side reports it, and a field the remote side never reported stays
 * ABSENT (never a measured 0).
 */

import { describe, expect, it } from "vitest"
import { projectRemoteUsage } from "../sandbox-usage.js"

describe("projectRemoteUsage", () => {
  it("forwards the cache split the remote side reports", () => {
    const usage = projectRemoteUsage({
      model: "claude-sonnet-4-5",
      costUsd: 0.42,
      tokensIn: 1_000,
      tokensOut: 500,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 3_000,
      reasoningTokens: 128,
    })
    expect(usage).toEqual({
      model: "claude-sonnet-4-5",
      costUsd: 0.42,
      tokensIn: 1_000,
      tokensOut: 500,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 3_000,
      reasoningTokens: 128,
    })
  })

  it("keeps an unreported split ABSENT, never 0", () => {
    const usage = projectRemoteUsage({ model: "m", costUsd: 1, tokensIn: 10, tokensOut: 5 })
    expect(usage).not.toBeNull()
    expect(usage?.cacheReadTokens).toBeUndefined()
    expect(usage?.cacheWriteTokens).toBeUndefined()
    expect(usage?.reasoningTokens).toBeUndefined()
    expect("cacheReadTokens" in (usage ?? {})).toBe(false)
  })

  it("ignores a non-numeric split rather than coercing it", () => {
    const usage = projectRemoteUsage({
      model: "m",
      tokensIn: 1,
      cacheReadTokens: "20" as unknown as number,
    })
    expect(usage?.cacheReadTokens).toBeUndefined()
  })

  it("returns null when the remote side reported nothing at all", () => {
    expect(projectRemoteUsage({})).toBeNull()
    expect(projectRemoteUsage({ model: "" })).toBeNull()
  })
})
