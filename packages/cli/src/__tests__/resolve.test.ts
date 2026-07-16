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
  it("rewrites a proprietary handle's `adapter` to an absolute, importable URL", { timeout: 15_000 }, async () => {
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

// The operator-visible bug this splits apart: `models.allowed` used to be a
// flat string, so a manifest could declare a gateway model id (Moonshot's
// kimi-k2.7-code) but had nowhere to say it needs claude-sdk's `moonshot`
// mode to actually route there — picking it from a flattened "slug · model"
// picker spawned in the adapter's default mode (native Anthropic), sending
// a Moonshot model id to the wrong provider. AIP-45's structured
// `{id, provider, mode}` form (declared on claude-sdk in
// adapters/claude-sdk/src/index.ts) closes that gap; `modelDetails` is
// where it's projected for every consumer (daemon HTTP/MCP `adapter_list`,
// the VS Code picker). This test fails without the fix: before it,
// `AdapterInfo` had no `modelDetails` field at all and the manifest could
// only declare bare strings, so there was no `mode`/`provider` to assert.
describe("listInstalledAdapters — structured models.allowed (provider/mode)", () => {
  it("projects claude-sdk's kimi-k2.7-code with its moonshot provider+mode binding", async () => {
    const adapters = await listInstalledAdapters()
    const claudeSdk = adapters.find((a) => a.slug === "claude-sdk")
    expect(claudeSdk).toBeDefined()

    const kimi = claudeSdk?.modelDetails.find((m) => m.id === "kimi-k2.7-code")
    expect(kimi).toBeDefined()
    expect(kimi?.provider).toBe("moonshot")
    expect(kimi?.mode).toBe("moonshot")

    // The flat `models: string[]` field is untouched by this change — every
    // existing consumer of that contract keeps working, id-for-id.
    expect(claudeSdk?.models).toContain("kimi-k2.7-code")
  })

  it("leaves a native Anthropic model with no mode binding — it needs no gateway switch", async () => {
    const adapters = await listInstalledAdapters()
    const claudeSdk = adapters.find((a) => a.slug === "claude-sdk")

    const sonnet = claudeSdk?.modelDetails.find((m) => m.id === "claude-sonnet-5")
    expect(sonnet?.provider).toBe("anthropic")
    expect(sonnet?.mode).toBeUndefined()
  })

  // Back-compat: codex's manifest still declares `models.allowed` as bare
  // strings (untouched by this PR) — it must keep listing/spawning exactly
  // as before, and must report an unstated provider rather than a guessed
  // one (a wrong-but-confident guess would bill the wrong account).
  it("back-compat: a bare-string models.allowed (codex) still lists, with no provider guessed", async () => {
    const adapters = await listInstalledAdapters()
    const codex = adapters.find((a) => a.slug === "codex")
    expect(codex).toBeDefined()
    expect(codex?.models).toContain("gpt-5-codex")

    const entry = codex?.modelDetails.find((m) => m.id === "gpt-5-codex")
    expect(entry).toEqual({ id: "gpt-5-codex" })
  })
})

