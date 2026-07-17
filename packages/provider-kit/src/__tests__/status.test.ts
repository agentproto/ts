import { describe, it, expect } from "vitest"
import { computeStatus } from "../status.js"

describe("computeStatus (§2.6 truth table)", () => {
  it("!resolved → supported (regardless of other flags)", () => {
    for (const requiresSetup of [true, false]) {
      for (const ledgerExists of [true, false]) {
        for (const credsExist of [true, false, undefined]) {
          expect(
            computeStatus({ resolved: false, requiresSetup, ledgerExists, credsExist })
          ).toBe("supported")
        }
      }
    }
  })

  it("resolved && !requiresSetup → ready (no setup needed)", () => {
    expect(
      computeStatus({ resolved: true, requiresSetup: false, ledgerExists: false })
    ).toBe("ready")
    expect(
      computeStatus({ resolved: true, requiresSetup: false, ledgerExists: true, credsExist: false })
    ).toBe("ready")
  })

  it("resolved && requiresSetup && ledgerExists → ready", () => {
    expect(
      computeStatus({ resolved: true, requiresSetup: true, ledgerExists: true })
    ).toBe("ready")
  })

  it("resolved && requiresSetup && credsExist → ready", () => {
    expect(
      computeStatus({ resolved: true, requiresSetup: true, ledgerExists: false, credsExist: true })
    ).toBe("ready")
  })

  it("resolved && requiresSetup && !ledger && !creds → available", () => {
    expect(
      computeStatus({ resolved: true, requiresSetup: true, ledgerExists: false })
    ).toBe("available")
    expect(
      computeStatus({ resolved: true, requiresSetup: true, ledgerExists: false, credsExist: false })
    ).toBe("available")
  })

  it("credsExist undefined behaves like 'no creds info'", () => {
    expect(
      computeStatus({ resolved: true, requiresSetup: true, ledgerExists: false, credsExist: undefined })
    ).toBe("available")
  })
})

describe("computeStatus — authRequired × authConfigured (auth is its own axis)", () => {
  it("authRequired && !authConfigured beats !requiresSetup — the regression this axis exists for", () => {
    // claude-code: no setup[] (requiresSetup=false) but authEnforce:"always"
    // hard-fails every spawn without a credential. Must NOT report "ready".
    expect(
      computeStatus({
        resolved: true,
        requiresSetup: false,
        ledgerExists: false,
        authRequired: true,
        authConfigured: false,
      })
    ).toBe("available")
  })

  it("authRequired && authConfigured === undefined (no probe ran) also beats !requiresSetup", () => {
    expect(
      computeStatus({
        resolved: true,
        requiresSetup: false,
        ledgerExists: false,
        authRequired: true,
      })
    ).toBe("available")
  })

  it("authRequired && authConfigured === true ⇒ falls through to the normal requiresSetup rule (ready, no setup needed)", () => {
    expect(
      computeStatus({
        resolved: true,
        requiresSetup: false,
        ledgerExists: false,
        authRequired: true,
        authConfigured: true,
      })
    ).toBe("ready")
  })

  it("authRequired && authConfigured === false also beats a completed setup ledger — ledger||creds can't mask missing auth", () => {
    expect(
      computeStatus({
        resolved: true,
        requiresSetup: true,
        ledgerExists: true,
        credsExist: true,
        authRequired: true,
        authConfigured: false,
      })
    ).toBe("available")
  })

  it("!resolved still wins over everything, regardless of the auth axis", () => {
    expect(
      computeStatus({
        resolved: false,
        requiresSetup: false,
        ledgerExists: false,
        authRequired: true,
        authConfigured: false,
      })
    ).toBe("supported")
  })

  it("the other three families (tunnel/sandbox/eval) are unaffected when authRequired/authConfigured are simply omitted", () => {
    // Byte-identical to the pre-auth-axis behaviour for every existing call
    // site that never passes these fields.
    expect(
      computeStatus({ resolved: true, requiresSetup: false, ledgerExists: false })
    ).toBe("ready")
    expect(
      computeStatus({ resolved: true, requiresSetup: true, ledgerExists: true })
    ).toBe("ready")
    expect(
      computeStatus({ resolved: true, requiresSetup: true, ledgerExists: false, credsExist: true })
    ).toBe("ready")
    expect(
      computeStatus({ resolved: true, requiresSetup: true, ledgerExists: false })
    ).toBe("available")
  })
})
