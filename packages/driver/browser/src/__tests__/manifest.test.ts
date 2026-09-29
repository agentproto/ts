import { describe, expect, it } from "vitest"
import { browserManifestSchema, defineBrowser, type BrowserManifestInput } from "../index.js"

const good: BrowserManifestInput = {
  id: "camofox",
  name: "Camoufox",
  description: "Stealth Firefox behind a REST service.",
  version: "1.0.0",
  transport: "http",
  location: "local",
  capabilities: { stealth: true, downloads: true, recording: "screencast" },
  install: [{ method: "path" }],
  requires: { nativeLaunchOs: ["darwin"] },
  options: [{ id: "mode", type: "enum", enum: ["a", "b"], default: "a" }],
  config: [{ id: "port", kind: "prompt", prompt: "Port?", persist: { env: "PORT" } }],
}

const launch = async () => {
  throw new Error("not launched in manifest tests")
}

describe("browser manifest", () => {
  it("accepts a good manifest and defaults every capability to off", () => {
    const parsed = browserManifestSchema.parse(good)
    expect(parsed.capabilities.stealth).toBe(true)
    expect(parsed.capabilities.recording).toBe("screencast")
    expect(parsed.capabilities.cdp).toBe(false)
    expect(parsed.capabilities.canStealth).toBe(false)
  })

  it("accepts a minimal manifest", () => {
    const parsed = browserManifestSchema.parse({
      id: "min",
      name: "Min",
      description: "Minimal.",
      version: "0.1.0",
      transport: "cli",
      location: "remote",
    })
    expect(parsed.capabilities.recording).toBe("none")
    expect(parsed.install).toEqual([])
  })

  it.each([
    ["transport", { transport: "mcp" }],
    ["location", { location: "cloud" }],
    ["capability type", { capabilities: { cdp: "yes" } }],
    ["capability value", { capabilities: { recording: "gif" } }],
    ["unknown capability", { capabilities: { teleport: true } }],
    ["id", { id: "Not Kebab" }],
    ["enum option without values", { options: [{ id: "m", type: "enum" }] }],
    ["bad sha256", { install: [{ method: "download", verify_sha256: "abc" }] }],
  ])("rejects a bad %s", (_label, patch) => {
    expect(browserManifestSchema.safeParse({ ...good, ...patch }).success).toBe(false)
  })

  it("defineBrowser returns a frozen provider with defaults applied", () => {
    const provider = defineBrowser({ ...good, launch })
    expect(provider.id).toBe("camofox")
    expect(Object.isFrozen(provider)).toBe(true)
    expect(Object.isFrozen(provider.capabilities)).toBe(true)
    expect(provider.capabilities.headless).toBe(false)
    expect(provider.config).toHaveLength(1)
  })

  it("defineBrowser throws a readable error for a bad manifest or missing launch", () => {
    expect(() =>
      defineBrowser({ ...good, transport: "smoke-signal" as never, launch }),
    ).toThrow(/defineBrowser.*camofox.*transport/)
    expect(() => defineBrowser({ ...good, launch: undefined as never })).toThrow(
      /launch\(\)/,
    )
    expect(() => defineBrowser({ ...good, id: "X", launch })).toThrow(/invalid id/)
  })
})
