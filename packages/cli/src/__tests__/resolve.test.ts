import { describe, expect, it } from "vitest"
import { resolveAdapter, listInstalledAdapters } from "../registry/resolve.js"

// Regression test for a real bug: `createProprietaryProtocolArm` (inside
// @agentproto/driver-agent-cli, a package that deliberately does NOT
// depend on any specific adapter) re-imports `handle.adapter` a second
// time at session-start. A bare package-name specifier resolves fine from
// THIS module (packages/cli lists every known adapter as a
// devDependency) but fails to resolve from driver-agent-cli's own module
// location, because Node's bare-specifier resolution walks up ancestor
// `node_modules` starting from the IMPORTING module, not this one.
// `resolveAdapter` must rewrite `protocol: "proprietary"` handles'
// `adapter` field to an absolute, fully-resolved URL so the second import
// always succeeds regardless of which module performs it.
describe("resolveAdapter — proprietary adapter re-import fix", () => {
  it("rewrites a proprietary handle's `adapter` to an absolute, importable URL", async () => {
    const resolved = await resolveAdapter("mastracode-inprocess")
    expect(resolved.handle.protocol).toBe("proprietary")
    expect(resolved.handle.adapter).toMatch(/dist\/index\.mjs$/)

    // The actual failure mode this fix closes: a SECOND import of
    // `handle.adapter`, from any module, must succeed — not just the one
    // resolveAdapter() itself already performed above.
    const mod = (await import(resolved.handle.adapter!)) as Record<string, unknown>
    expect(typeof mod.createAgentCliClient).toBe("function")
  })

  it("leaves a non-proprietary handle's `adapter` field untouched (undefined)", async () => {
    const resolved = await resolveAdapter("mastracode")
    expect(resolved.handle.protocol).toBe("print")
    expect(resolved.handle.adapter).toBeUndefined()
  })
})

// `adapter_list` (the daemon MCP tool + GET /adapters) serialises exactly
// what `listInstalledAdapters()` returns. Each entry now carries the
// adapter's declared `modes[]` projected to the UI-safe subset with an
// honest support `status` — so a declared-but-no-op mode is visible to
// clients instead of being silently accepted. hermes' `lean` mode is the
// canonical measured no-op (see adapters/hermes/src/index.ts).
describe("listInstalledAdapters — mode status projection", () => {
  it("surfaces hermes' lean mode as status 'noop' with a status_note", async () => {
    const adapters = await listInstalledAdapters()
    const hermes = adapters.find((a) => a.slug === "hermes")
    expect(hermes).toBeDefined()

    const lean = hermes?.modes.find((m) => m.id === "lean")
    expect(lean).toBeDefined()
    expect(lean?.status).toBe("noop")
    expect(lean?.status_note).toBeTruthy()

    // A mode without an explicit status normalises to "active" (never
    // left statusless), so clients can rely on the field always being set.
    const def = hermes?.modes.find((m) => m.id === "default")
    expect(def?.status).toBe("active")
  })
})

