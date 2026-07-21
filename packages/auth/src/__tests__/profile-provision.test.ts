import { describe, expect, it } from "vitest"
import type { AuthProfile } from "../profile-types.js"
import { MemoryStore } from "../store/memory-store.js"
import {
  AuthProfileValidationError,
  createAuthProfile,
  deleteAuthProfile,
  deriveCredentialRef,
  fingerprintCredential,
  validateCreateInput,
  type ProfileProvisionDeps,
} from "../profile-provision.js"

/** In-memory ProfileProvisionDeps backed by a Map — no filesystem, no
 *  keychain. `store` is a real `MemoryStore` so secret round-trips are
 *  exercised for real. */
function makeDeps(seed: AuthProfile[] = []): {
  deps: ProfileProvisionDeps
  profiles: Map<string, AuthProfile>
  store: MemoryStore
} {
  const profiles = new Map(seed.map(p => [p.id, p]))
  const store = new MemoryStore()
  const deps: ProfileProvisionDeps = {
    store,
    getProfile: async id => profiles.get(id),
    listProfiles: async () => [...profiles.values()],
    addProfile: async p => {
      profiles.set(p.id, p)
    },
    removeProfile: async id => profiles.delete(id),
  }
  return { deps, profiles, store }
}

describe("validateCreateInput", () => {
  const base = {
    id: "anthropic-sub",
    endpoint: "anthropic",
    method: "oauth-bearer" as const,
    credential: "secret-token",
  }

  it("trims and returns normalized fields", () => {
    const v = validateCreateInput({
      ...base,
      id: "  anthropic-sub ",
      endpoint: " anthropic ",
      credential: " secret-token\n",
      label: "  Anthropic Subscription  ",
    })
    expect(v).toEqual({
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "oauth-bearer",
      credential: "secret-token",
      label: "Anthropic Subscription",
    })
  })

  it("rejects a missing id", () => {
    expect(() => validateCreateInput({ ...base, id: "  " })).toThrow(
      AuthProfileValidationError,
    )
  })

  it("rejects a bad id charset", () => {
    expect(() => validateCreateInput({ ...base, id: "bad id!" })).toThrow(/invalid/)
  })

  it("rejects a missing endpoint", () => {
    expect(() => validateCreateInput({ ...base, endpoint: "" })).toThrow(/endpoint/)
  })

  it("rejects an unknown method", () => {
    expect(() =>
      validateCreateInput({ ...base, method: "totp" as never }),
    ).toThrow(/method/)
  })

  it("rejects a blank credential", () => {
    expect(() => validateCreateInput({ ...base, credential: "   " })).toThrow(
      /credential/,
    )
  })
})

describe("deriveCredentialRef", () => {
  it("api-key → agentproto.auth.<endpoint>", () => {
    expect(deriveCredentialRef({ endpoint: "moonshot", method: "api-key" })).toBe(
      "agentproto.auth.moonshot",
    )
  })

  it("oauth-bearer → agentproto.auth.<endpoint>.sub", () => {
    expect(
      deriveCredentialRef({ endpoint: "anthropic", method: "oauth-bearer" }),
    ).toBe("agentproto.auth.anthropic.sub")
  })

  it("appends a qualifier to disambiguate", () => {
    expect(
      deriveCredentialRef({
        endpoint: "anthropic",
        method: "oauth-bearer",
        qualifier: "work",
      }),
    ).toBe("agentproto.auth.anthropic.sub.work")
  })
})

describe("fingerprintCredential", () => {
  it("is deterministic, 12 hex chars, and not the secret", () => {
    const fp = fingerprintCredential("secret-token")
    expect(fp).toMatch(/^[0-9a-f]{12}$/)
    expect(fp).toBe(fingerprintCredential("secret-token"))
    expect(fp).not.toContain("secret")
  })

  it("differs for different secrets", () => {
    expect(fingerprintCredential("a")).not.toBe(fingerprintCredential("b"))
  })
})

describe("createAuthProfile", () => {
  it("writes the secret to the store and records metadata (no echo)", async () => {
    const { deps, profiles, store } = makeDeps()
    const created = await createAuthProfile(
      {
        id: "anthropic-sub",
        endpoint: "anthropic",
        method: "oauth-bearer",
        credential: "sub-token",
        label: "Anthropic Subscription",
      },
      deps,
    )

    // Result carries metadata + fingerprint, never the credential.
    expect(created).toEqual({
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "oauth-bearer",
      credentialRef: "agentproto.auth.anthropic.sub",
      label: "Anthropic Subscription",
      fingerprint: fingerprintCredential("sub-token"),
    })
    expect(JSON.stringify(created)).not.toContain("sub-token")

    // Metadata persisted, secret persisted at the derived slot.
    expect(profiles.get("anthropic-sub")?.credentialRef).toBe(
      "agentproto.auth.anthropic.sub",
    )
    const stored = await store.read({ path: "agentproto.auth.anthropic.sub" })
    expect(stored).toEqual({ value: "sub-token", kind: "oat" })
  })

  it("maps api-key → pat kind", async () => {
    const { deps, store } = makeDeps()
    await createAuthProfile(
      { id: "or-api", endpoint: "openrouter", method: "api-key", credential: "or-key" },
      deps,
    )
    const stored = await store.read({ path: "agentproto.auth.openrouter" })
    expect(stored?.kind).toBe("pat")
  })

  it("rejects a duplicate id", async () => {
    const { deps } = makeDeps([
      {
        id: "anthropic-sub",
        endpoint: "anthropic",
        method: "oauth-bearer",
        credentialRef: "agentproto.auth.anthropic.sub",
      },
    ])
    await expect(
      createAuthProfile(
        {
          id: "anthropic-sub",
          endpoint: "anthropic",
          method: "oauth-bearer",
          credential: "x",
        },
        deps,
      ),
    ).rejects.toThrow(/already exists/)
  })

  it("qualifies the slot when the derived ref is already taken", async () => {
    const { deps, store } = makeDeps([
      {
        id: "anthropic-sub",
        endpoint: "anthropic",
        method: "oauth-bearer",
        credentialRef: "agentproto.auth.anthropic.sub",
      },
    ])
    const created = await createAuthProfile(
      {
        id: "anthropic-sub-work",
        endpoint: "anthropic",
        method: "oauth-bearer",
        credential: "work-token",
      },
      deps,
    )
    // Distinct slot → the first profile's secret is not clobbered.
    expect(created.credentialRef).toBe("agentproto.auth.anthropic.sub.anthropic-sub-work")
    expect(await store.read({ path: created.credentialRef })).toEqual({
      value: "work-token",
      kind: "oat",
    })
  })

  it("honours an explicit credentialRef", async () => {
    const { deps, store } = makeDeps()
    const created = await createAuthProfile(
      {
        id: "custom",
        endpoint: "anthropic",
        method: "api-key",
        credential: "k",
        credentialRef: "agentproto.auth.custom.slot",
      },
      deps,
    )
    expect(created.credentialRef).toBe("agentproto.auth.custom.slot")
    expect(await store.read({ path: "agentproto.auth.custom.slot" })).toBeDefined()
  })
})

describe("deleteAuthProfile", () => {
  it("removes the profile and its credential", async () => {
    const { deps, profiles, store } = makeDeps()
    await createAuthProfile(
      { id: "or-api", endpoint: "openrouter", method: "api-key", credential: "or-key" },
      deps,
    )
    const result = await deleteAuthProfile("or-api", deps)
    expect(result).toEqual({
      deleted: true,
      id: "or-api",
      credentialRef: "agentproto.auth.openrouter",
    })
    expect(profiles.has("or-api")).toBe(false)
    expect(await store.read({ path: "agentproto.auth.openrouter" })).toBeUndefined()
  })

  it("is idempotent for a missing id", async () => {
    const { deps } = makeDeps()
    await expect(deleteAuthProfile("nope", deps)).resolves.toEqual({
      deleted: false,
      id: "nope",
    })
  })

  it("keeps the credential when another profile still references the slot", async () => {
    const shared = "agentproto.auth.anthropic"
    const { deps, store } = makeDeps([
      { id: "a", endpoint: "anthropic", method: "api-key", credentialRef: shared },
      { id: "b", endpoint: "anthropic", method: "api-key", credentialRef: shared },
    ])
    await store.write({ path: shared }, { value: "k", kind: "pat" })

    await deleteAuthProfile("a", deps)
    // b still points at the slot → the secret must survive.
    expect(await store.read({ path: shared })).toBeDefined()

    await deleteAuthProfile("b", deps)
    // Last referrer gone → the secret is removed.
    expect(await store.read({ path: shared })).toBeUndefined()
  })
})
