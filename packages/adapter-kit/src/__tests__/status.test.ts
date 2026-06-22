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
