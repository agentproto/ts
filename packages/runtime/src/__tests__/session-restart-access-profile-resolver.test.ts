/**
 * Direct unit coverage for `resolveAccessProfileFromStore` (the DEFAULT
 * `AccessProfileResolver` in session-restart-core.ts) — every other restart
 * test injects a stub resolver, so this function's own behavior against
 * `getAuthProfile` + `KeychainStore` otherwise has no coverage at all.
 *
 * Restart does not (yet) support self-refreshing `source`-backed profiles —
 * only spawn does (session-spawn.ts). This locks the fail-loud guard: a
 * source-backed profile must reject with `RestartOverrideError` rather than
 * crash on `KeychainStore().read({ path: undefined })` or silently restart
 * with no credential.
 */

import { describe, it, expect, vi } from "vitest"

const authProfileState = vi.hoisted(() => ({
  profiles: {} as Record<string, import("@agentproto/auth").AuthProfile>,
  keychain: {} as Record<string, string | undefined>,
}))
vi.mock("@agentproto/auth", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/auth")>()
  return {
    ...actual,
    getAuthProfile: vi.fn(async (id: string) => authProfileState.profiles[id]),
    KeychainStore: vi.fn().mockImplementation(() => ({
      read: vi.fn(async ({ path }: { path: string }) => {
        const value = authProfileState.keychain[path]
        return value !== undefined ? { value, kind: "oat" as const } : undefined
      }),
    })),
  }
})

import { resolveAccessProfileFromStore, RestartOverrideError } from "../session-restart-core.js"

describe("resolveAccessProfileFromStore", () => {
  it("returns undefined for an unknown profile id", async () => {
    authProfileState.profiles = {}
    authProfileState.keychain = {}
    await expect(resolveAccessProfileFromStore("nope")).resolves.toBeUndefined()
  })

  it("a credential-backed profile reads its secret from the keychain slot", async () => {
    authProfileState.profiles = {
      "anthropic-sub": {
        id: "anthropic-sub",
        endpoint: "anthropic",
        method: "oauth-bearer",
        credentialRef: "agentproto.auth.anthropic.sub",
      },
    }
    authProfileState.keychain = { "agentproto.auth.anthropic.sub": "sk-ant-oat01-stored" }
    const found = await resolveAccessProfileFromStore("anthropic-sub")
    expect(found?.credential).toBe("sk-ant-oat01-stored")
    expect(found?.profile.id).toBe("anthropic-sub")
  })

  it("a source-backed profile fails LOUD (RestartOverrideError) rather than crash or silently spawn with no credential", async () => {
    authProfileState.profiles = {
      "anthropic-sub": {
        id: "anthropic-sub",
        endpoint: "anthropic",
        method: "oauth-bearer",
        source: "claude-code-oauth",
      },
    }
    authProfileState.keychain = {}
    await expect(resolveAccessProfileFromStore("anthropic-sub")).rejects.toThrow(
      RestartOverrideError,
    )
    await expect(resolveAccessProfileFromStore("anthropic-sub")).rejects.toThrow(
      /source-backed/,
    )
  })
})
