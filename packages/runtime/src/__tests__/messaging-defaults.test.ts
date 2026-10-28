/**
 * `resolveMessagingDefaults` (messaging-defaults.ts) — the per-call reader
 * for `defaults.agentPromptInterrupt` / `defaults.messaging.allowSiblings` /
 * `defaults.messaging.allowSameWorkspace` / `defaults.messaging.agentInterrupt`
 * that replaced the boot-time
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

  it("reads every knob from config.defaults when set", async () => {
    const result = await resolveMessagingDefaults(async () => ({
      defaults: {
        agentPromptInterrupt: true,
        messaging: {
          allowSiblings: true,
          allowSameWorkspace: false,
          peerGroups: [["agentik-studio", "app-agentik-pygmalion"]],
          agentInterrupt: "allow",
          pendingPromptStaleMinutes: 12,
        },
      },
    }))
    expect(result).toEqual({
      agentPromptInterrupt: true,
      allowSiblings: true,
      allowSameWorkspace: false,
      peerGroups: [["agentik-studio", "app-agentik-pygmalion"]],
      peerBinding: "slug",
      agentInterrupt: "allow",
      pendingPromptStaleMinutes: 12,
    })
  })

  it("defaults the peer groups to none (no cross-workspace link)", async () => {
    const result = await resolveMessagingDefaults(async () => ({
      defaults: { messaging: { allowSiblings: true } },
    }))
    expect(result.peerGroups).toEqual([])
    expect(DEFAULT_MESSAGING_DEFAULTS.peerGroups).toEqual([])
  })

  it("P5 resolves peerBinding: slug by default, verified when configured", async () => {
    const empty = await resolveMessagingDefaults(async () => ({}))
    expect(empty.peerBinding).toBe("slug")
    expect(DEFAULT_MESSAGING_DEFAULTS.peerBinding).toBe("slug")
    const verified = await resolveMessagingDefaults(async () => ({
      defaults: { messaging: { peerBinding: "verified" } },
    }))
    expect(verified.peerBinding).toBe("verified")
  })

  it("defaults the same-workspace allowance to ON", async () => {
    const result = await resolveMessagingDefaults(async () => ({
      defaults: { messaging: { allowSiblings: true } },
    }))
    expect(result.allowSameWorkspace).toBe(true)
    expect(DEFAULT_MESSAGING_DEFAULTS.allowSameWorkspace).toBe(true)
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
