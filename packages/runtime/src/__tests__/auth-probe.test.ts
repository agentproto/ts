/**
 * `isAgentCliAuthConfigured` — the honest auth-readiness probe behind
 * `adapter_list`'s status. THE MONEY REGRESSION (see auth-probe.ts's doc
 * comment / PR #321): a probe that answers "is auth configured?" by checking
 * `providers.json` alone reports `true` for a spawn that still throws
 * `missing_auth_credential`, because the store is only consulted when auth
 * is EXPLICITLY configured (`defaults.adapters.<slug>.auth` in config.json).
 * This suite is written against that trap first — the probe MUST mirror
 * `resolveAuthSpec`'s exact precedence, not reimplement it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const providerKeys = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }))
const config = vi.hoisted(() => ({ value: {} as { defaults?: unknown } }))

vi.mock("../providers-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers-store.js")>()
  return { ...actual, getProviderKey: vi.fn(async (p: string) => providerKeys.value[p]) }
})
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>()
  return { ...actual, loadConfig: vi.fn(async () => config.value) }
})

import { isAgentCliAuthConfigured } from "../auth-probe.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"

// The claude-code auth descriptor the runtime projects from the manifest —
// same shape as spawn-defaults.test.ts's CLAUDE_CODE_DESCRIPTOR.
const CLAUDE_CODE_DESCRIPTOR: AdapterAuthDescriptor = {
  provider: "anthropic",
  authEnforce: "always",
  authSubscription: {
    setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    conflictEnv: ["ANTHROPIC_AUTH_TOKEN"],
  },
}

beforeEach(() => {
  providerKeys.value = {}
  config.value = {}
})

describe("isAgentCliAuthConfigured — the money regression (PR #321)", () => {
  it("returns false for claude-code when providers.json HAS a key but config.json has no auth block — the point of this PR", async () => {
    // A user ran `agentproto auth provider set anthropic sk-…` at some point
    // (or it's a leftover from another adapter) — the key is real...
    providerKeys.value = { anthropic: "sk-ant-api03-leftover" }
    // ...but nothing in config.json opted claude-code into auth at all.
    config.value = {}
    // A naive "does providers.json have a key" probe would say `true` here —
    // that's exactly the lie `adapter_list` used to tell. The real spawn
    // path (session-spawn.ts:612-617) never even reads the store in this
    // state (the `explicit` gate), so it still throws
    // `missing_auth_credential`. The probe must agree with the spawn path.
    expect(await isAgentCliAuthConfigured("claude-code", CLAUDE_CODE_DESCRIPTOR)).toBe(false)
  })

  it("returns false when nothing is configured anywhere", async () => {
    expect(await isAgentCliAuthConfigured("claude-code", CLAUDE_CODE_DESCRIPTOR)).toBe(false)
  })

  it("returns true when a subscription token is configured in config.json (no store involved — subscription has no store path)", async () => {
    config.value = {
      defaults: {
        adapters: {
          "claude-code": { auth: { mode: "subscription", token: "sk-ant-oat01-real" } },
        },
      },
    }
    expect(await isAgentCliAuthConfigured("claude-code", CLAUDE_CODE_DESCRIPTOR)).toBe(true)
  })

  it("returns true for {mode:'api-key'} config + a providers.json key (explicit ⇒ store consulted)", async () => {
    providerKeys.value = { anthropic: "sk-ant-api03-real" }
    config.value = {
      defaults: { adapters: { "claude-code": { auth: { mode: "api-key" } } } },
    }
    expect(await isAgentCliAuthConfigured("claude-code", CLAUDE_CODE_DESCRIPTOR)).toBe(true)
  })

  it("returns false for an explicit api-key mode with no credential anywhere (config nor store)", async () => {
    config.value = {
      defaults: { adapters: { "claude-code": { auth: { mode: "api-key" } } } },
    }
    expect(await isAgentCliAuthConfigured("claude-code", CLAUDE_CODE_DESCRIPTOR)).toBe(false)
  })
})
