import { afterEach, describe, expect, it } from "vitest"
import type { AuthProfile } from "../profile-types.js"
import {
  findSubaccountProvider,
  getSubaccountProvider,
  listSubaccountProviders,
  migrateLegacySubaccountProfile,
  parseSubaccountPin,
  registerSubaccountProvider,
  unregisterSubaccountProvider,
  type SubaccountProvider,
} from "../subaccounts.js"

const fake: SubaccountProvider = {
  id: "fake",
  source: "fake-login",
  endpoints: ["fake-api"],
  kinds: ["project"],
  list: async () => ({ account: { id: "a" }, subaccounts: [] }),
  resolve: async () => ({}),
  migrateLegacySource: s => (s.startsWith("fake-login:") ? { kind: "project", id: s.slice(11) } : undefined),
}

afterEach(() => unregisterSubaccountProvider("fake"))

describe("parseSubaccountPin", () => {
  it("splits on the first colon", () => {
    expect(parseSubaccountPin("org:org_1")).toEqual({ kind: "org", id: "org_1" })
    expect(parseSubaccountPin("project:a:b")).toEqual({ kind: "project", id: "a:b" })
  })
  it("rejects malformed specs", () => {
    for (const bad of ["", "org", ":x", "org:", "Org:x", "1org:x"]) {
      expect(parseSubaccountPin(bad)).toBeUndefined()
    }
  })
})

describe("provider registry", () => {
  it("registers, finds by source and by endpoint, and unregisters", () => {
    registerSubaccountProvider(fake)
    expect(getSubaccountProvider("fake")).toBe(fake)
    expect(listSubaccountProviders()).toContain(fake)
    expect(findSubaccountProvider({ source: "fake-login" })).toBe(fake)
    expect(findSubaccountProvider({ source: "fake-login:p1" })).toBe(fake)
    expect(findSubaccountProvider({ endpoint: "fake-api" })).toBe(fake)
    expect(findSubaccountProvider({ source: "other" })).toBeUndefined()
    expect(unregisterSubaccountProvider("fake")).toBe(true)
    expect(findSubaccountProvider({ source: "fake-login" })).toBeUndefined()
  })
})

describe("migrateLegacySubaccountProfile", () => {
  const legacy: AuthProfile = {
    id: "p",
    endpoint: "fake-api",
    method: "api-key",
    source: "fake-login:proj_1",
  }
  it("lifts the encoded pin into the generic shape, without mutating", () => {
    registerSubaccountProvider(fake)
    const out = migrateLegacySubaccountProfile(legacy)
    expect(out.source).toBe("fake-login")
    expect(out.subaccount).toEqual({ kind: "project", id: "proj_1" })
    expect(legacy.source).toBe("fake-login:proj_1")
  })
  it("leaves already-generic and unrelated profiles alone", () => {
    registerSubaccountProvider(fake)
    const generic = { ...legacy, source: "fake-login", subaccount: { kind: "project", id: "x" } }
    expect(migrateLegacySubaccountProfile(generic)).toBe(generic)
    const plain: AuthProfile = { id: "q", endpoint: "anthropic", method: "oauth-bearer", source: "claude-code-oauth" }
    expect(migrateLegacySubaccountProfile(plain)).toBe(plain)
  })
  it("is a no-op when no provider is registered", () => {
    expect(migrateLegacySubaccountProfile(legacy)).toBe(legacy)
  })
})
