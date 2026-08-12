import { describe, expect, it } from "vitest"
import { agentCliFrontmatterSchema } from "@agentproto/driver-agent-cli"
import type { AgentprotoConfig } from "@agentproto/runtime/config"
import {
  acpHandleFromSpec,
  ACP_CATALOG,
  resolveAcpSpec,
  binOnPath,
  fallbackBinDirs,
  listAcpGenericAdapters,
  type AcpAgentSpec,
} from "../acp-generic.js"
import { resolveAdapter } from "../resolve.js"

// ── acpHandleFromSpec: spec → handle mapping ────────────────────────────

describe("acpHandleFromSpec", () => {
  it("mints a schema-valid ACP handle from a minimal spec", () => {
    const handle = acpHandleFromSpec({ slug: "my-agent", bin: "my-agent" })
    expect(handle.protocol).toBe("acp")
    expect(handle.id).toBe("my-agent")
    expect(handle.name).toBe("my-agent")
    expect(handle.bin).toBe("my-agent")
    // The AIP-45 `acp` ref is satisfied (required when protocol=acp).
    expect(handle.acp).toBeTruthy()
    // Passes the full AIP-45 frontmatter schema — identical validity to a
    // hand-authored native ACP adapter.
    expect(agentCliFrontmatterSchema.safeParse(handle).success).toBe(true)
  })

  it("maps bin_args, name, description, and env through", () => {
    const handle = acpHandleFromSpec({
      slug: "gemini-cli",
      name: "Gemini CLI",
      description: "test desc",
      bin: "gemini",
      bin_args: ["--experimental-acp"],
      env: { FOO: "bar" },
    })
    expect(handle.name).toBe("Gemini CLI")
    expect(handle.description).toBe("test desc")
    expect(handle.bin_args).toEqual(["--experimental-acp"])
    expect(handle.env).toEqual({ FOO: "bar" })
  })

  it("wires resumable → capabilities.resumable + native-resume continuation", () => {
    const handle = acpHandleFromSpec({
      slug: "res-agent",
      bin: "res-agent",
      resumable: true,
    })
    expect(handle.capabilities?.resumable).toBe(true)
    expect(handle.session?.mode).toBe("resumable")
    expect(handle.continuation?.default).toBe("native-resume")
  })

  it("leaves resumable off by default (persistent session, no native-resume)", () => {
    const handle = acpHandleFromSpec({ slug: "plain-agent", bin: "plain-agent" })
    expect(handle.capabilities?.resumable).toBe(false)
    expect(handle.session?.mode).toBe("persistent")
    expect(handle.continuation).toBeUndefined()
  })

  it("maps models default + allowed through", () => {
    const handle = acpHandleFromSpec({
      slug: "model-agent",
      bin: "model-agent",
      models: { default: "m-1", allowed: ["m-1", "m-2"] },
    })
    expect(handle.models?.default).toBe("m-1")
    expect(handle.models?.allowed).toEqual(["m-1", "m-2"])
  })

  it("throws a clear AIP-45 error for an invalid slug (id pattern)", () => {
    // AIP-45 ids are ≥2 chars, lower-kebab; a 1-char slug fails validation
    // loudly rather than minting a subtly-broken handle.
    expect(() => acpHandleFromSpec({ slug: "a", bin: "a" })).toThrow(/AIP-45/)
  })
})

// ── ACP_CATALOG: every curated entry is valid ───────────────────────────

describe("ACP_CATALOG", () => {
  it("is non-empty and has unique slugs", () => {
    expect(ACP_CATALOG.length).toBeGreaterThan(0)
    const slugs = ACP_CATALOG.map((e) => e.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it("every entry produces a schema-valid handle and carries an install hint + bin", () => {
    for (const entry of ACP_CATALOG) {
      expect(entry.bin, `${entry.slug} bin`).toBeTruthy()
      expect(entry.install_hint, `${entry.slug} install_hint`).toBeTruthy()
      const handle = acpHandleFromSpec(entry)
      expect(
        agentCliFrontmatterSchema.safeParse(handle).success,
        `${entry.slug} schema`,
      ).toBe(true)
    }
  })
})

// ── resolveAcpSpec: config shadows catalog ──────────────────────────────

describe("resolveAcpSpec", () => {
  const catalogSlug = ACP_CATALOG[0]!.slug

  it("returns a catalog entry with source 'acp-catalog'", async () => {
    const hit = await resolveAcpSpec(catalogSlug, {})
    expect(hit?.source).toBe("acp-catalog")
    expect(hit?.spec.slug).toBe(catalogSlug)
  })

  it("config entry shadows the catalog entry of the same slug", async () => {
    const config: AgentprotoConfig = {
      acpAgents: { [catalogSlug]: { bin: "override-bin" } },
    }
    const hit = await resolveAcpSpec(catalogSlug, config)
    expect(hit?.source).toBe("acp-config")
    expect(hit?.spec.bin).toBe("override-bin")
  })

  it("returns null for an unknown slug", async () => {
    const hit = await resolveAcpSpec("definitely-not-a-real-agent", {})
    expect(hit).toBeNull()
  })
})

// ── resolveAdapter: resolution order npm > config > catalog ──────────────

describe("resolveAdapter — generic ACP fallback", () => {
  it("falls back to the ACP catalog when no npm package exists", async () => {
    // No `@agentproto/adapter-gemini-cli` package exists, so resolution
    // falls through npm → config → catalog and lands on the catalog.
    const resolved = await resolveAdapter("gemini-cli")
    expect(resolved.source).toBe("acp-catalog")
    expect(resolved.handle.protocol).toBe("acp")
    expect(resolved.handle.bin).toBe("gemini")
  })

  it("npm still wins for a real adapter package (never shadowed by generic)", async () => {
    // claude-code ships a native adapter — it must resolve via npm even
    // though the generic paths run in the same resolver.
    const resolved = await resolveAdapter("claude-code")
    expect(resolved.source).toBe("npm")
  })
})

// ── binOnPath ───────────────────────────────────────────────────────────

describe("binOnPath", () => {
  it("finds a bin that is on PATH", async () => {
    // `node` is guaranteed present in the test runner's PATH.
    expect(await binOnPath("node")).toBe(true)
  })

  it("returns false for a bin that is not installed", async () => {
    expect(await binOnPath("definitely-not-a-real-binary-xyz")).toBe(false)
  })
})

// ── fallbackBinDirs ─────────────────────────────────────────────────────
// `binOnPath` also checks these — the well-known install dirs for the
// package managers `install-hint.ts` drives (uv/pipx/pip --user, cargo, go,
// brew) — so a `uv tool install`/`cargo install`/… run by a long-running
// daemon process is visible on the very next listing even when that
// directory isn't (yet) on the daemon's inherited PATH. See the doc comment
// on `fallbackBinDirs` for the "installed but doesn't show as installed"
// bug this guards against.

describe("fallbackBinDirs", () => {
  it("includes the well-known package-manager install directories", () => {
    const dirs = fallbackBinDirs()
    expect(dirs.some((d) => d.endsWith(".local/bin"))).toBe(true)
    expect(dirs.some((d) => d.endsWith(".cargo/bin"))).toBe(true)
    expect(dirs.some((d) => d.endsWith("go/bin"))).toBe(true)
    expect(dirs).toContain("/opt/homebrew/bin")
    expect(dirs).toContain("/usr/local/bin")
  })
})

// ── listAcpGenericAdapters ──────────────────────────────────────────────

describe("listAcpGenericAdapters", () => {
  it("lists catalog entries with a status and source", async () => {
    const entries = await listAcpGenericAdapters({ config: {} })
    expect(entries.length).toBe(ACP_CATALOG.length)
    for (const e of entries) {
      expect(["ready", "supported"]).toContain(e.status)
      expect(e.source).toBe("acp-catalog")
      expect(e.protocol).toBe("acp")
    }
  })

  it("includes config-defined agents and lets them shadow catalog", async () => {
    const config: AgentprotoConfig = {
      acpAgents: {
        "custom-agent": { bin: "custom", name: "Custom" },
        [ACP_CATALOG[0]!.slug]: { bin: "shadow-bin" },
      },
    }
    const entries = await listAcpGenericAdapters({ config })
    const custom = entries.find((e) => e.slug === "custom-agent")
    expect(custom?.source).toBe("acp-config")
    const shadowed = entries.find((e) => e.slug === ACP_CATALOG[0]!.slug)
    expect(shadowed?.source).toBe("acp-config")
  })

  it("drops slugs listed in excludeSlugs", async () => {
    const exclude = new Set([ACP_CATALOG[0]!.slug])
    const entries = await listAcpGenericAdapters({ config: {}, excludeSlugs: exclude })
    expect(entries.find((e) => e.slug === ACP_CATALOG[0]!.slug)).toBeUndefined()
  })

  const specForType: AcpAgentSpec = { slug: "type-check", bin: "type-check" }
  it("spec type stays assignable (compile-time guard)", () => {
    expect(specForType.slug).toBe("type-check")
  })
})
