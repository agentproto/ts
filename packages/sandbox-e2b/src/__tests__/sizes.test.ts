import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"

const { sandboxCreateMock } = vi.hoisted(() => ({ sandboxCreateMock: vi.fn() }))

vi.mock("e2b", () => ({
  Sandbox: { create: sandboxCreateMock },
  CommandExitError: class CommandExitError extends Error {},
  SandboxNotFoundError: class SandboxNotFoundError extends Error {},
}))

function fakeSandbox() {
  return {
    sandboxId: "sbx_abc",
    getHost: vi.fn((port: number) => `sbx-abc-${port}.e2b.dev`),
    commands: { run: vi.fn(async () => ({})) },
    kill: vi.fn(async () => true),
  }
}

// Everything below derives from the generated SIZES (versions.json), so a
// re-publish or a plan-limit change never needs a test edit.
const { SIZES, DEFAULT_SIZE, DEFAULT_TEMPLATE, TEMPLATES, resolveTemplate, resolveUpdateCli } =
  await import("../provider.js")
type Size = keyof typeof SIZES
const entries = Object.entries(SIZES) as [Size, (typeof SIZES)[Size]][]
const available = entries.filter(([, preset]) => preset.available)
const unavailable = entries.filter(([, preset]) => !preset.available)

describe("size presets (config.size)", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sandboxCreateMock.mockReset()
    fetchMock = vi.fn().mockResolvedValue({ ok: true }) // daemon already up
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const boot = async (config: Record<string, unknown>) => {
    const { e2bSandboxProvider } = await import("../provider.js")
    const spec: SandboxSpec = { provider: "e2b", config }
    return e2bSandboxProvider.boot(spec, { env: {} })
  }

  it("declares the default size as an available preset", () => {
    expect(SIZES[DEFAULT_SIZE].available).toBe(true)
    expect(available.length).toBeGreaterThan(0)
  })

  it.each(available)("size %s boots that preset's published template", async (name, preset) => {
    sandboxCreateMock.mockResolvedValue(fakeSandbox())
    await boot({ size: name })
    expect(sandboxCreateMock).toHaveBeenCalledWith(preset.id ?? preset.alias, expect.anything())
    expect(preset.alias).toBe(`${TEMPLATES.stable.alias}-${name}`)
  })

  it("no size and no template still boots the bare default template", async () => {
    sandboxCreateMock.mockResolvedValue(fakeSandbox())
    await boot({})
    expect(sandboxCreateMock).toHaveBeenCalledWith(DEFAULT_TEMPLATE, expect.anything())
    expect(resolveTemplate({})).toBe(DEFAULT_TEMPLATE)
  })

  it("an explicit config.template wins over config.size", async () => {
    sandboxCreateMock.mockResolvedValue(fakeSandbox())
    await boot({ template: "my-template", size: available[0]![0] })
    expect(sandboxCreateMock).toHaveBeenCalledWith("my-template", expect.anything())
  })

  it("an unknown size fails before any box is created, listing the valid sizes", async () => {
    await expect(boot({ size: "huge" })).rejects.toThrow(
      `unknown config.size "huge"; valid sizes: ${Object.keys(SIZES).join(", ")}`,
    )
    await expect(boot({ size: 8 })).rejects.toThrow(/unknown config.size 8; valid sizes:/)
    expect(sandboxCreateMock).not.toHaveBeenCalled()
  })

  it.skipIf(unavailable.length === 0)(
    "an unavailable size fails with the recorded e2b error instead of booting a smaller box",
    async () => {
      for (const [name, preset] of unavailable) {
        const reason = "unavailableReason" in preset ? preset.unavailableReason : ""
        expect(reason).not.toBe("")
        await expect(boot({ size: name })).rejects.toThrow(
          `size "${name}" (${preset.cpuCount} vCPU / ${preset.memoryMb} MB) is unavailable — e2b refused to create its template: ${reason}`,
        )
        // an explicit template still wins, even over an unavailable size
        expect(resolveTemplate({ size: name, template: "custom" })).toBe("custom")
      }
      expect(sandboxCreateMock).not.toHaveBeenCalled()
    },
  )

  it("a size template's recorded bake gates the boot install like the stable one", () => {
    for (const [, preset] of available) {
      if (preset.id === null) continue
      const proven = preset.baked.cli !== null
      expect(resolveUpdateCli({}, preset.id)).toBe(!proven)
    }
  })
})
