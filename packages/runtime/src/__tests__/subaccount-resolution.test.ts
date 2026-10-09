import { afterEach, describe, expect, it } from "vitest"
import {
  SubaccountError,
  registerSubaccountProvider,
  unregisterSubaccountProvider,
  type AuthProfile,
  type SubaccountProvider,
} from "@agentproto/auth"
import { resolveProfileSubaccount } from "../subaccount-resolution.js"
import { resolveAuthSpec, SubscriptionSourceError, type AdapterAuthDescriptor } from "../spawn-defaults.js"

/** A second, entirely fictional provider — nothing in the runtime knows it. */
function fakeProvider(overrides: Partial<SubaccountProvider> = {}): SubaccountProvider {
  return {
    id: "fake-vendor",
    endpoints: ["openai"],
    kinds: ["project"],
    list: async () => ({ account: { id: "acct" }, subaccounts: [] }),
    resolve: async profile => ({
      env: { FAKE_PROJECT: profile.subaccount.id },
      isolateDataHome: false,
    }),
    ...overrides,
  }
}

const profile: AuthProfile = {
  id: "fake-proj",
  endpoint: "openai",
  method: "api-key",
  credentialRef: "slot",
  subaccount: { kind: "project", id: "proj_9", name: "Nine" },
}

afterEach(() => unregisterSubaccountProvider("fake-vendor"))

describe("resolveProfileSubaccount (registry, no provider imported)", () => {
  it("returns undefined for a profile with no pin", async () => {
    const { subaccount: _drop, ...plain } = profile
    await expect(resolveProfileSubaccount(plain)).resolves.toBeUndefined()
  })

  it("applies a fake second provider and keeps the stored credential", async () => {
    registerSubaccountProvider(fakeProvider())
    const out = await resolveProfileSubaccount(profile, { credential: "sk-stored" })
    expect(out?.pin).toEqual(profile.subaccount)
    expect(out?.credential).toBe("sk-stored")
    expect(out?.authInputs).toEqual({ extraEnv: { FAKE_PROJECT: "proj_9" }, isolateDataHome: false })
  })

  it("lets a provider supply its own scoped credential and env var", async () => {
    registerSubaccountProvider(
      fakeProvider({
        resolve: async () => ({ credential: "scoped-token", credentialEnvOverride: "FAKE_TOKEN" }),
      }),
    )
    const out = await resolveProfileSubaccount(profile)
    expect(out?.credential).toBe("scoped-token")
    expect(out?.authInputs).toEqual({
      credentialEnvOverride: "FAKE_TOKEN",
      apiKeyCredentialSource: "subaccount",
    })
  })

  it("fails loud when no provider is registered for the account", async () => {
    await expect(resolveProfileSubaccount(profile)).rejects.toThrow(/no sub-account provider is registered/)
    await expect(resolveProfileSubaccount(profile)).rejects.toBeInstanceOf(SubscriptionSourceError)
  })

  it("maps a provider SubaccountError onto the spawn error code, message intact", async () => {
    registerSubaccountProvider(
      fakeProvider({
        resolve: async () => {
          throw new SubaccountError("project proj_9 not found")
        },
      }),
    )
    const err = await resolveProfileSubaccount(profile).catch(e => e)
    expect(err).toBeInstanceOf(SubscriptionSourceError)
    expect(err.code).toBe("auth_source_unresolved")
    expect(err.message).toBe("project proj_9 not found")
  })

  it("does not swallow unexpected provider errors", async () => {
    registerSubaccountProvider(
      fakeProvider({
        resolve: async () => {
          throw new TypeError("boom")
        },
      }),
    )
    await expect(resolveProfileSubaccount(profile)).rejects.toBeInstanceOf(TypeError)
  })
})

describe("resolveAuthSpec with sub-account inputs", () => {
  const descriptor: AdapterAuthDescriptor = { authEnforce: "always" }
  it("injects the scoped credential under the override env, scrubs the key env, and echoes the source", () => {
    const { spec, echo } = resolveAuthSpec({
      descriptor,
      requestedProvider: "openai" as never,
      requestedMode: "api-key",
      explicit: true,
      apiKeyConfigCredential: "scoped-token",
      credentialEnvOverride: "FAKE_TOKEN",
      apiKeyCredentialSource: "subaccount",
      extraEnv: { FAKE_PROJECT: "proj_9" },
      isolateDataHome: false,
    })!
    expect(spec.setEnv).toBe("FAKE_TOKEN")
    expect(spec.credential).toBe("scoped-token")
    expect(spec.extraEnv).toEqual({ FAKE_PROJECT: "proj_9" })
    expect(spec.isolateDataHome).toBe(false)
    expect(spec.unsetEnv).toContain("OPENAI_API_KEY")
    expect(echo.credentialSource).toBe("subaccount")
    expect(echo.fingerprint).not.toContain("scoped-token")
  })

  it("a plain api-key profile is unchanged: own key env, no extraEnv, no isolation opt-out", () => {
    const { spec } = resolveAuthSpec({
      descriptor,
      requestedProvider: "openai" as never,
      requestedMode: "api-key",
      explicit: true,
      apiKeyConfigCredential: "k-plain",
    })!
    expect(spec.setEnv).toBe("OPENAI_API_KEY")
    expect(spec.extraEnv).toBeUndefined()
    expect(spec.isolateDataHome).toBeUndefined()
  })
})
