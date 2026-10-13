/**
 * Keychain-backed sandbox passthrough: a name the daemon env cannot supply is
 * resolved from the OS keychain via an explicit `{ name, credentialRef }`
 * entry or the attached auth profile's own `credentialRef`. The keychain is a
 * mock `CredentialStore` — nothing here touches a real keychain, the network,
 * or a sandbox. Credential values are fake.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import type { CredentialStore } from "@agentproto/auth"
import type { SandboxSpec } from "@agentproto/sandbox"

import {
  autoCredentialRefOf,
  buildSandboxSecretResolver,
} from "../sandbox-secret-resolver.js"
import { withSandboxAuthAutoPassthrough } from "../session-spawn.js"
import type { ResolvedAuthSpec } from "../spawn-defaults.js"
import { sandboxSpecWithReuseSchema } from "../sandbox-spec-schema.js"

const KEYCHAIN_VALUE = "ghp_fake_keychain_value_0001"
const ENV_VALUE = "ghp_fake_env_value_0002"

function mockStore(entries: Record<string, string>): {
  store: Pick<CredentialStore, "read">
  reads: string[]
} {
  const reads: string[] = []
  return {
    reads,
    store: {
      async read(ref) {
        reads.push(ref.path)
        const value = entries[ref.path]
        return value === undefined ? undefined : { value, kind: "pat" }
      },
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("buildSandboxSecretResolver", () => {
  it("returns the broker value and never touches the keychain when the env has it", async () => {
    const { store, reads } = mockStore({ "agentproto.git.x": KEYCHAIN_VALUE })
    const resolve = buildSandboxSecretResolver({
      base: async slug => (slug === "GH" ? ENV_VALUE : null),
      refs: new Map([["GH", "agentproto.git.x"]]),
      store,
    })
    expect(await resolve("GH")).toBe(ENV_VALUE)
    expect(reads).toEqual([])
  })

  it("prefers the keychain over the broker for a keychainFirst name, and falls back to the broker", async () => {
    const { store, reads } = mockStore({ "agentproto.git.x": KEYCHAIN_VALUE })
    const resolve = buildSandboxSecretResolver({
      base: async () => ENV_VALUE,
      refs: new Map([["GH", "agentproto.git.x"], ["OTHER", "agentproto.git.x"]]),
      keychainFirst: new Set(["GH"]),
      store,
    })
    expect(await resolve("GH")).toBe(KEYCHAIN_VALUE)
    expect(await resolve("OTHER")).toBe(ENV_VALUE)
    expect(reads).toEqual(["agentproto.git.x"])

    const empty = buildSandboxSecretResolver({
      base: async () => ENV_VALUE,
      refs: new Map([["GH", "agentproto.git.missing"]]),
      keychainFirst: new Set(["GH"]),
      store: mockStore({}).store,
    })
    expect(await empty("GH")).toBe(ENV_VALUE)
  })

  it("falls back to the keychain slot named by the credentialRef", async () => {
    const { store, reads } = mockStore({ "agentproto.git.x": KEYCHAIN_VALUE })
    const resolve = buildSandboxSecretResolver({
      base: async () => null,
      refs: new Map([["GH", "agentproto.git.x"]]),
      store,
    })
    expect(await resolve("GH")).toBe(KEYCHAIN_VALUE)
    expect(reads).toEqual(["agentproto.git.x"])
  })

  it("returns null for a name with no ref, and for an empty keychain slot", async () => {
    const { store } = mockStore({})
    const resolve = buildSandboxSecretResolver({
      base: async () => null,
      refs: new Map([["GH", "agentproto.git.missing"]]),
      store,
    })
    expect(await resolve("OTHER")).toBeNull()
    expect(await resolve("GH")).toBeNull()
  })

  it("degrades a keychain failure to null and never logs the value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const resolve = buildSandboxSecretResolver({
      base: async () => null,
      refs: new Map([["GH", "agentproto.git.x"]]),
      store: {
        async read() {
          throw new Error("keychain locked")
        },
      },
    })
    expect(await resolve("GH")).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = String(warn.mock.calls[0]?.[0])
    expect(logged).toContain("keychain locked")
    expect(logged).not.toContain(KEYCHAIN_VALUE)
  })

  it("sees refs added after construction (the auto-passthrough entry)", async () => {
    const { store } = mockStore({ "profile-slot": KEYCHAIN_VALUE })
    const refs = new Map<string, string>()
    const resolve = buildSandboxSecretResolver({ base: async () => null, refs, store })
    expect(await resolve("ANTHROPIC_API_KEY")).toBeNull()
    refs.set("ANTHROPIC_API_KEY", "profile-slot")
    expect(await resolve("ANTHROPIC_API_KEY")).toBe(KEYCHAIN_VALUE)
  })
})

describe("autoCredentialRefOf", () => {
  it("exposes a profile's credentialRef, but not for a sub-account pin or no ref", () => {
    expect(autoCredentialRefOf({ credentialRef: "slot" })).toBe("slot")
    expect(autoCredentialRefOf({})).toBeUndefined()
    expect(autoCredentialRefOf(undefined)).toBeUndefined()
    expect(
      autoCredentialRefOf({
        credentialRef: "slot",
        subaccount: { kind: "org", id: "o1" },
      }),
    ).toBeUndefined()
  })
})

describe("withSandboxAuthAutoPassthrough — keychain fallback", () => {
  const authSpec: ResolvedAuthSpec = {
    mode: "api-key",
    credential: "unused-in-this-path",
    setEnv: "ANTHROPIC_API_KEY",
    unsetEnv: [],
    explicit: true,
    enforce: "when-configured",
  }
  const baseSpec: SandboxSpec = { provider: "fake", config: {}, env: { autoPassthrough: true } }

  it("injects a keychain-only credential's NAME via the profile ref and keeps the value out of the spec", async () => {
    const { store } = mockStore({ "profile-slot": KEYCHAIN_VALUE })
    const refs = new Map<string, string>()
    const spec = await withSandboxAuthAutoPassthrough(baseSpec, authSpec, {
      resolve: buildSandboxSecretResolver({ base: async () => null, refs, store }),
      refs,
      autoRef: "profile-slot",
    })
    expect(spec.env?.passthrough).toEqual(["ANTHROPIC_API_KEY"])
    expect(refs.get("ANTHROPIC_API_KEY")).toBe("profile-slot")
    expect(JSON.stringify(spec)).not.toContain(KEYCHAIN_VALUE)
  })

  it("still warns and skips when neither env nor keychain has the value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { store } = mockStore({})
    const refs = new Map<string, string>()
    const spec = await withSandboxAuthAutoPassthrough(baseSpec, authSpec, {
      resolve: buildSandboxSecretResolver({ base: async () => null, refs, store }),
      refs,
      autoRef: "profile-slot",
    })
    expect(spec.env?.passthrough ?? []).not.toContain("ANTHROPIC_API_KEY")
    expect(warn).toHaveBeenCalled()
  })

  it("without an auto ref a keychain-only credential is skipped, as before", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const refs = new Map<string, string>()
    const spec = await withSandboxAuthAutoPassthrough(baseSpec, authSpec, {
      resolve: buildSandboxSecretResolver({ base: async () => null, refs, store: mockStore({}).store }),
      refs,
      autoRef: undefined,
    })
    expect(spec.env?.passthrough ?? []).not.toContain("ANTHROPIC_API_KEY")
  })

  it("prefers the daemon env over the keychain slot", async () => {
    const { store, reads } = mockStore({ "profile-slot": KEYCHAIN_VALUE })
    const refs = new Map<string, string>()
    const spec = await withSandboxAuthAutoPassthrough(baseSpec, authSpec, {
      resolve: buildSandboxSecretResolver({ base: async () => ENV_VALUE, refs, store }),
      refs,
      autoRef: "profile-slot",
    })
    expect(spec.env?.passthrough).toEqual(["ANTHROPIC_API_KEY"])
    expect(reads).toEqual([])
  })
})

describe("sandboxSpecWithReuseSchema — no caller-supplied keychain refs", () => {
  it("rejects a credentialRefs payload so a caller can never name a keychain slot", () => {
    const parsed = sandboxSpecWithReuseSchema.safeParse({
      provider: "e2b",
      config: {},
      credentialRefs: [{ name: "STOLEN", credentialRef: "agentproto.auth.victim" }],
    })
    expect(parsed.success).toBe(false)
  })
})
