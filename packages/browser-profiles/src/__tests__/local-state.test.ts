import { describe, expect, it } from "vitest"
import { chromeTimeToIso, chromeUserDataDir, parseLocalState, readLocalState } from "../index.js"

describe("Local State parsing (the one shared implementation)", () => {
  const text = JSON.stringify({
    profile: {
      last_used: "Profile 1",
      info_cache: {
        Default: { name: "Work", user_name: "w@example.test", gaia_name: "W", active_time: 13300000000.5 },
        "Profile 1": { last_active_time: 1_700_000_000 },
      },
    },
  })

  it("maps info_cache to profiles and reads last_used", () => {
    const s = parseLocalState(text)
    expect(s.lastUsed).toBe("Profile 1")
    expect(s.profiles).toEqual([
      { directory: "Default", name: "Work", userName: "w@example.test", gaiaName: "W", activeTime: 13300000000.5 },
      { directory: "Profile 1", name: undefined, userName: undefined, gaiaName: undefined, activeTime: 1_700_000_000 },
    ])
  })

  it("tolerates a bare document and throws on malformed JSON", () => {
    expect(parseLocalState("{}")).toEqual({ profiles: [], lastUsed: null })
    expect(() => parseLocalState("{nope")).toThrow()
  })

  it("readLocalState is lenient on a missing dir", () => {
    expect(readLocalState("/synthetic/does-not-exist")).toEqual({ profiles: [], lastUsed: null })
  })

  it("chromeTimeToIso handles chrome micros, unix ms/s, and junk", () => {
    expect(chromeTimeToIso((1_700_000_000_000 + 11_644_473_600_000) * 1000)).toBe("2023-11-14T22:13:20.000Z")
    expect(chromeTimeToIso(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z")
    expect(chromeTimeToIso(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z")
    expect(chromeTimeToIso(undefined)).toBe("")
    expect(chromeTimeToIso(-1)).toBe("")
  })

  it("chromeUserDataDir derives from the passed home (pure, no fs access)", () => {
    expect(chromeUserDataDir("/synthetic/home")).toContain("/synthetic/home")
  })
})
