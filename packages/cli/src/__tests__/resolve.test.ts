import { describe, expect, it } from "vitest"
import { createRequire } from "node:module"
import { promises as fs } from "node:fs"
import {
  resolveAdapter,
  listInstalledAdapters,
  listAdaptersWithCatalog,
  toAuthDescriptor,
  _resetLastKnownGoodForTests,
  _setLastKnownGoodTtlMsForTests,
} from "../registry/resolve.js"
import { CATALOG } from "../registry/catalog.js"

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
  it("surfaces hermes' lean mode as status 'noop' with a status_note", { timeout: 15_000 }, async () => {
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

// `routeSelection` (AIP-45 launch-menu drill-down, WP1) rides the same
// `adapter_list` projection as `modes`/`modelDetails`: a capability-derived
// spawn/config drill-down reads it to decide whether the connection step is a
// real route choice (`"free"`) or a read-only badge (`"derived-from-model"`,
// where the endpoint falls out of the model id's vendor prefix). This asserts
// the shipped manifests are classified — and projected — as intended.
describe("listInstalledAdapters — routeSelection projection", () => {
  it("projects the Claude adapters as free (route is an independent choice)", { timeout: 15_000 }, async () => {
    const adapters = await listInstalledAdapters()
    for (const slug of ["claude-code", "claude-sdk"]) {
      const a = adapters.find((x) => x.slug === slug)
      expect(a, `${slug} should be installed`).toBeDefined()
      expect(a?.routeSelection).toBe("free")
    }
  })

  it("projects hermes as derived-from-model (route falls out of the model prefix)", async () => {
    const adapters = await listInstalledAdapters()
    const hermes = adapters.find((a) => a.slug === "hermes")
    expect(hermes).toBeDefined()
    expect(hermes?.routeSelection).toBe("derived-from-model")
  })

  it("classifies every by-model router present as derived-from-model", async () => {
    const adapters = await listInstalledAdapters()
    // Any of these that resolved in this checkout must be derived-from-model —
    // a present-but-misclassified router fails loudly; an absent one is skipped
    // (not every optional adapter is built in every checkout).
    for (const slug of ["mastracode", "mastracode-inprocess", "pi", "opencode", "mastra-agent"]) {
      const a = adapters.find((x) => x.slug === slug)
      if (a) expect(a.routeSelection, `${slug}`).toBe("derived-from-model")
    }
  })

  it("back-compat: an adapter that declares no routeSelection (codex) leaves it undefined ⇒ free default", async () => {
    const adapters = await listInstalledAdapters()
    const codex = adapters.find((a) => a.slug === "codex")
    expect(codex).toBeDefined()
    expect(codex?.routeSelection).toBeUndefined()
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
  it("projects claude-sdk's kimi-k2.7-code with its moonshot provider (runtime-routed, no manifest mode binding)", async () => {
    const adapters = await listInstalledAdapters()
    const claudeSdk = adapters.find((a) => a.slug === "claude-sdk")
    expect(claudeSdk).toBeDefined()

    const kimi = claudeSdk?.modelDetails.find((m) => m.id === "kimi-k2.7-code")
    expect(kimi).toBeDefined()
    expect(kimi?.provider).toBe("moonshot")
    // Gateway routing is now resolved at runtime from the session `route` axis;
    // the manifest no longer hard-codes a gateway mode binding.
    expect(kimi?.mode).toBeUndefined()

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

// `toAuthDescriptor` projects the manifest billing-auth fields into the
// runtime's `AdapterAuthDescriptor`. For model-derived-api-key adapters
// (opencode), the flag must flow through so the catalog join and spawn
// eligibility know api-key auth is presentable on the model-derived route.
describe("toAuthDescriptor", () => {
  it("projects modelDerivedApiKey and per-model providers", { timeout: 15_000 }, async () => {
    const resolved = await resolveAdapter("opencode")
    const descriptor = toAuthDescriptor(resolved.handle)
    expect(descriptor.modelDerivedApiKey).toBe(true)
    expect(descriptor.modelProviders).toBeDefined()
    expect(descriptor.modelProviders?.["anthropic/claude-sonnet-4-5"]).toBe("anthropic")
    expect(descriptor.modelProviders?.["openai/gpt-5"]).toBe("openai")
    expect(descriptor.modelProviders?.["openrouter/anthropic/claude-fable-5"]).toBe("openrouter")
  })

  it("drops unrecognized provider strings instead of guessing", () => {
    const descriptor = toAuthDescriptor({
      provider: "not-a-real-provider",
      models: {
        allowed: [
          { id: "foo/bar", provider: "also-not-real" },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof resolveAdapter>>["handle"])
    expect(descriptor.provider).toBeUndefined()
    expect(Object.keys(descriptor.modelProviders ?? {})).toHaveLength(0)
  })
})

// Incident regression: a real `pnpm build` (or `tsup --watch`) rewriting an
// adapter's dist mid-request made `resolveAdapter` throw, and the daemon
// reported an installed, working adapter as "not installed" — see the PR
// description for the live-probe evidence that `tsup`'s `clean: true`
// genuinely deletes `dist/*` before rewriting it (not just briefly
// unreadable), so a disk-existence check can't tell "rebuilding" from
// "uninstalled" apart. These tests corrupt a REAL adapter's REAL dist file
// (no mocking of `resolveAdapter` itself) to reproduce both windows.
//
// "opencode" and "pi" are used here (not touched by real resolution
// anywhere else in this package's test suite) so mutating their dist files
// can't race a concurrently-running test file.
const requireFromHere = createRequire(import.meta.url)

async function withMutatedDist<T>(
  packageName: string,
  mutate: "delete" | "truncate",
  fn: () => Promise<T>
): Promise<T> {
  const distPath = requireFromHere.resolve(packageName)
  const original = await fs.readFile(distPath)
  try {
    if (mutate === "delete") {
      await fs.unlink(distPath)
    } else {
      await fs.writeFile(distPath, "{")
    }
    return await fn()
  } finally {
    await fs.writeFile(distPath, original)
  }
}

describe("resolveAdapter — last-known-good fallback for a mid-rebuild adapter", () => {
  it("prefers the cached handle over reporting a previously-resolved adapter as not-installed", async () => {
    _resetLastKnownGoodForTests()
    const first = await resolveAdapter("opencode")
    expect(first.stale).toBeUndefined()

    await withMutatedDist("@agentproto/adapter-opencode", "delete", async () => {
      // The dominant window this PR fixes: tsup's clean step deletes the
      // file outright (see the PR description's live-probe measurements),
      // so a fresh resolveAdapter() call throws a plain module-not-found —
      // exactly like an uninstalled package, by disk state alone.
      const second = await resolveAdapter("opencode")
      expect(second.stale).toBe(true)
      expect(second.handle).toEqual(first.handle)
      expect(second.source).toBe(first.source)
    })
  })

  it("does not report the fallback as plain 'ready' in adapter_list — a distinct status, no install advice", async () => {
    _resetLastKnownGoodForTests()
    await resolveAdapter("opencode")

    await withMutatedDist("@agentproto/adapter-opencode", "delete", async () => {
      const listed = await listAdaptersWithCatalog(CATALOG)
      const entry = listed.find((a) => a.slug === "opencode")
      expect(entry).toBeDefined()
      expect(entry?.status).not.toBe("ready")
      expect(entry?.status).not.toBe("supported")
      expect(entry?.status).toBe("unresolvable")
      expect(entry?.hint ?? "").not.toMatch(/agentproto install/i)
    })
  })
})

describe("resolveAdapter — regression: a never-resolved adapter is unaffected", () => {
  it("a genuinely unknown slug still throws the classic 'could not load adapter' error", async () => {
    await expect(
      resolveAdapter("totally-not-a-real-adapter-xyz")
    ).rejects.toThrow(/could not load adapter/)
  })

  it("listAdaptersWithCatalog still reports a never-resolved catalog entry as 'supported' (not installed)", async () => {
    const fakeCatalog = [
      {
        slug: "totally-not-a-real-adapter-xyz",
        name: "Fake Adapter",
        description: "does not exist, for the regression test",
        packageName: "@agentproto/adapter-totally-not-a-real-adapter-xyz",
      },
    ]
    const listed = await listAdaptersWithCatalog(fakeCatalog)
    const entry = listed.find((a) => a.slug === "totally-not-a-real-adapter-xyz")
    expect(entry?.status).toBe("supported")
    expect(entry?.version).toBe("not installed")
  })
})

describe("resolveAdapter — the error text for a transient failure doesn't send the operator to reinstall", () => {
  it("names 'resolves on disk but could not be imported' instead of 'not installed' when the package IS present but momentarily broken", async () => {
    _resetLastKnownGoodForTests()
    await withMutatedDist("@agentproto/adapter-pi", "truncate", async () => {
      // No prior successful resolve in this process (reset above) and the
      // file still exists with garbage content — the narrow window this
      // PR's `AdapterImportFailedError` distinguishes: present, but the
      // import itself just failed.
      try {
        await resolveAdapter("pi")
        expect.fail("resolveAdapter('pi') should have thrown")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        expect(message).toMatch(/resolves on disk but could not be imported/)
        expect(message).not.toMatch(/agentproto install/i)
        expect(message).not.toMatch(/npm i -g/i)
      }
    })
  })
})

describe("resolveAdapter — last-known-good is bounded by a TTL, not disk existence", () => {
  it("stops trusting a stale resolution once the TTL elapses, so a genuinely-removed adapter is reported as not-installed again", async () => {
    _resetLastKnownGoodForTests()
    const restoreTtl = _setLastKnownGoodTtlMsForTests(20)
    try {
      await resolveAdapter("opencode") // primes the cache while the dist file is intact

      await withMutatedDist("@agentproto/adapter-opencode", "delete", async () => {
        await new Promise((r) => setTimeout(r, 80)) // outlive the 20ms TTL
        await expect(resolveAdapter("opencode")).rejects.toThrow()

        const listed = await listAdaptersWithCatalog(CATALOG)
        const entry = listed.find((a) => a.slug === "opencode")
        expect(entry?.status).toBe("supported")
        expect(entry?.status).not.toBe("unresolvable")
        expect(entry?.status).not.toBe("ready")
      })
    } finally {
      restoreTtl()
    }
  })
})
