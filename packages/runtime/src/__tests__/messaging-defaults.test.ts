/**
 * `resolveMessagingDefaults` (messaging-defaults.ts) — the per-call reader
 * for `defaults.agentPromptInterrupt` / `defaults.messaging.allowSiblings` /
 * `defaults.messaging.agentInterrupt` that replaced the boot-time
 * `configDefaults` snapshot in index.ts. No caching: every call re-reads
 * via the injected loader, exactly like `spawn-attach.ts` /
 * `worktree-isolation.ts` — a `config_set` change is visible on the very
 * next call.
 */

import { describe, expect, it } from "vitest"
import { resolveMessagingDefaults, DEFAULT_MESSAGING_DEFAULTS } from "../messaging-defaults.js"

describe("resolveMessagingDefaults", () => {
  it("falls back to false/false/deny when config has no defaults block", async () => {
    const result = await resolveMessagingDefaults(async () => ({}))
    expect(result).toEqual(DEFAULT_MESSAGING_DEFAULTS)
  })

  it("reads all three knobs from config.defaults when set", async () => {
    const result = await resolveMessagingDefaults(async () => ({
      defaults: {
        agentPromptInterrupt: true,
        messaging: { allowSiblings: true, agentInterrupt: "allow" },
      },
    }))
    expect(result).toEqual({
      agentPromptInterrupt: true,
      allowSiblings: true,
      agentInterrupt: "allow",
    })
  })

  it("falls back to the defaults when the loader throws (never propagates)", async () => {
    const result = await resolveMessagingDefaults(async () => {
      throw new Error("disk on fire")
    })
    expect(result).toEqual(DEFAULT_MESSAGING_DEFAULTS)
  })

  it("re-reads on every call — a config change between two calls is visible on the second, no caching", async () => {
    let allowSiblings = false
    const loadCfg = async () => ({ defaults: { messaging: { allowSiblings } } })

    const first = await resolveMessagingDefaults(loadCfg)
    expect(first.allowSiblings).toBe(false)

    // Simulates a `config_set` landing on disk between two calls.
    allowSiblings = true
    const second = await resolveMessagingDefaults(loadCfg)
    expect(second.allowSiblings).toBe(true)
  })
})
