import { describe, expect, it } from "vitest"
import type { AuthProfile } from "../profile-types.js"
import { MemoryStore } from "../store/memory-store.js"
import {
  AuthProfileValidationError,
  createAuthProfile,
  credentialIdentity,
  deleteAuthProfile,
  deriveCredentialRef,
  fingerprintCredential,
  setAuthProfileEnabled,
  setAuthProfileModels,
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

  it("accepts a source in place of a credential for oauth-bearer", () => {
    const v = validateCreateInput({
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "oauth-bearer",
      source: " claude-code-oauth ",
    })
    expect(v).toEqual({
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "oauth-bearer",
      source: "claude-code-oauth",
    })
  })

  it("rejects giving both credential and source", () => {
    expect(() =>
      validateCreateInput({ ...base, source: "claude-code-oauth" }),
    ).toThrow(/either credential or source/)
  })

  it("rejects giving neither credential nor source for oauth-bearer", () => {
    expect(() =>
      validateCreateInput({ ...base, credential: undefined }),
    ).toThrow(/credential or source is required/)
  })

  it("rejects a source on an api-key profile", () => {
    expect(() =>
      validateCreateInput({
        id: "or-api",
        endpoint: "openrouter",
        method: "api-key",
        source: "claude-code-oauth",
      }),
    ).toThrow(/source is only supported for oauth-bearer/)
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

describe("credentialIdentity (WS5)", () => {
  it("returns a fingerprint + last4 for a normal-length secret, never the secret", () => {
    const id = credentialIdentity("sk-ant-abcdefgh1234")
    expect(id).toEqual({
      fingerprint: fingerprintCredential("sk-ant-abcdefgh1234"),
      last4: "1234",
    })
    expect(JSON.stringify(id)).not.toContain("sk-ant-abcdefgh")
  })

  it("withholds last4 for a too-short secret (fail closed, never expose a tail)", () => {
    const id = credentialIdentity("abc")
    expect(id.fingerprint).toMatch(/^[0-9a-f]{12}$/)
    expect(id.last4).toBeUndefined()
  })
})

describe("setAuthProfileEnabled (WS2)", () => {
  it("disabling sets disabled:true; enabling clears the field (absent = enabled)", async () => {
    const { deps, profiles } = makeDeps([
      { id: "p", endpoint: "anthropic", method: "api-key", credentialRef: "ref" },
    ])
    const disabled = await setAuthProfileEnabled("p", false, deps)
    expect(disabled.disabled).toBe(true)
    expect(profiles.get("p")?.disabled).toBe(true)

    const enabled = await setAuthProfileEnabled("p", true, deps)
    // The field is gone entirely — byte-identical to a never-disabled profile.
    expect(enabled).not.toHaveProperty("disabled")
    expect(profiles.get("p")).toEqual({
      id: "p",
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: "ref",
    })
  })

  it("rejects an unknown id", async () => {
    const { deps } = makeDeps()
    await expect(setAuthProfileEnabled("nope", false, deps)).rejects.toThrow(
      AuthProfileValidationError,
    )
  })
})

describe("setAuthProfileModels (WS3)", () => {
  it("mode:allow stores a de-duped, trimmed allowlist", async () => {
    const { deps, profiles } = makeDeps([
      { id: "p", endpoint: "anthropic", method: "api-key", credentialRef: "ref" },
    ])
    const updated = await setAuthProfileModels(
      "p",
      { mode: "allow", ids: [" anthropic/claude-opus-4-8 ", "anthropic/claude-opus-4-8", "", "x/y"] },
      deps,
    )
    expect(updated.models).toEqual({ mode: "allow", ids: ["anthropic/claude-opus-4-8", "x/y"] })
    expect(profiles.get("p")?.models).toEqual({
      mode: "allow",
      ids: ["anthropic/claude-opus-4-8", "x/y"],
    })
  })

  it("mode:all clears any stored allowlist (absent = services everything)", async () => {
    const { deps, profiles } = makeDeps([
      {
        id: "p",
        endpoint: "anthropic",
        method: "api-key",
        credentialRef: "ref",
        models: { mode: "allow", ids: ["a/b"] },
      },
    ])
    const updated = await setAuthProfileModels("p", { mode: "all", ids: [] }, deps)
    expect(updated).not.toHaveProperty("models")
    expect(profiles.get("p")).toEqual({
      id: "p",
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: "ref",
    })
  })

  it("rejects an unknown id", async () => {
    const { deps } = makeDeps()
    await expect(
      setAuthProfileModels("nope", { mode: "allow", ids: [] }, deps),
    ).rejects.toThrow(AuthProfileValidationError)
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
    expect(await store.read({ path: created.credentialRef! })).toEqual({
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

  it("a source-backed profile stores no secret and carries no credentialRef/fingerprint", async () => {
    const { deps, profiles, store } = makeDeps()
    const created = await createAuthProfile(
      {
        id: "anthropic-sub",
        endpoint: "anthropic",
        method: "oauth-bearer",
        source: "claude-code-oauth",
        label: "Anthropic (self-refreshing)",
      },
      deps,
    )
    expect(created).toEqual({
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "oauth-bearer",
      source: "claude-code-oauth",
      label: "Anthropic (self-refreshing)",
    })
    expect(profiles.get("anthropic-sub")).toEqual({
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "oauth-bearer",
      source: "claude-code-oauth",
      label: "Anthropic (self-refreshing)",
    })
    // Nothing was ever written to the credential store.
    expect(await store.read({ path: "agentproto.auth.anthropic.sub" })).toBeUndefined()
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

  it("deletes a source-backed profile without touching the credential store", async () => {
    const { deps, profiles } = makeDeps()
    await createAuthProfile(
      { id: "anthropic-sub", endpoint: "anthropic", method: "oauth-bearer", source: "claude-code-oauth" },
      deps,
    )
    const result = await deleteAuthProfile("anthropic-sub", deps)
    expect(result).toEqual({ deleted: true, id: "anthropic-sub" })
    expect(profiles.has("anthropic-sub")).toBe(false)
  })
})

describe("createAuthProfile — origin provenance (WS6)", () => {
  it("stamps origin on a credential-backed profile (returned + persisted)", async () => {
    const { deps, profiles } = makeDeps()
    const created = await createAuthProfile(
      { id: "env-openrouter", endpoint: "openrouter", method: "api-key", credential: "sk-x", origin: "env" },
      deps,
    )
    expect(created.origin).toBe("env")
    expect(profiles.get("env-openrouter")?.origin).toBe("env")
    // The credential is still never echoed — only a fingerprint.
    expect(created.fingerprint).toBeTruthy()
    expect(JSON.stringify(created)).not.toContain("sk-x")
  })

  it("stamps origin on a source-backed profile", async () => {
    const { deps, profiles } = makeDeps()
    const created = await createAuthProfile(
      { id: "codex-openai", endpoint: "openai", method: "oauth-bearer", source: "codex", origin: "codex" },
      deps,
    )
    expect(created.origin).toBe("codex")
    expect(profiles.get("codex-openai")?.origin).toBe("codex")
  })

  it("omits origin when none is given (byte-identical to a pre-WS6 profile)", async () => {
    const { deps, profiles } = makeDeps()
    await createAuthProfile(
      { id: "openrouter-api", endpoint: "openrouter", method: "api-key", credential: "sk-y" },
      deps,
    )
    expect(profiles.get("openrouter-api")).not.toHaveProperty("origin")
  })
})
