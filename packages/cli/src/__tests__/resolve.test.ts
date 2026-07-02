import { describe, expect, it } from "vitest"
import { resolveAdapter } from "../registry/resolve.js"

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
