import { describe, expect, it } from "vitest"

import type { AdapterInfo, AuthProfileSummary, HarnessCapabilities } from "../client/types.js"
import { reach } from "./authModelMindmap.logic.js"
import {
  buildHarnessesWebviewModel,
  harnessStatusFor,
  type HarnessWebviewRow,
} from "./harnessesWebview.logic.js"

function adapter(over: Partial<AdapterInfo> = {}): AdapterInfo {
  return {
    slug: "claude-code",
    name: "Claude Code",
    protocol: "acp",
    version: "1.0",
    status: "ready",
    hint: "anthropic · ACP · resumable",
    ...over,
  }
}

function profile(over: Partial<AuthProfileSummary>): AuthProfileSummary {
  return { id: "p", endpoint: "anthropic", method: "api-key", ...over }
}

const claudeCodeAdapter: AdapterInfo = {
  slug: "claude-code",
  name: "Claude Code",
  status: "ready",
  routeSelection: "free",
  modelDetails: [
    { id: "claude-opus-4-8", provider: "anthropic" },
    { id: "kimi-k3", provider: "moonshot" },
  ],
}
const claudeCodeCap: HarnessCapabilities = {
  adapter: "claude-code",
  endpointCompat: { anthropic: { via: "env", key: "ANTHROPIC_BASE_URL" } },
  providers: [
    { id: "anthropic", billingEndpoint: "anthropic", apiMode: "anthropic" },
    { id: "moonshot", billingEndpoint: "moonshot", apiMode: "anthropic" },
  ],
}

describe("harnessStatusFor", () => {
  it("maps ready to ready", () => {
    expect(harnessStatusFor("ready")).toBe("ready")
  })

  it("maps available and supported to available", () => {
    expect(harnessStatusFor("available")).toBe("available")
    expect(harnessStatusFor("supported")).toBe("available")
  })

  it("maps everything else to dim", () => {
    expect(harnessStatusFor("unresolvable")).toBe("dim")
    expect(harnessStatusFor(undefined)).toBe("dim")
  })
})

describe("buildHarnessesWebviewModel", () => {
  it("sorts ready before available before supported", () => {
    const adapters = [
      adapter({ slug: "supported", status: "supported" }),
      adapter({ slug: "ready", status: "ready" }),
      adapter({ slug: "available", status: "available" }),
    ]
    const model = buildHarnessesWebviewModel(adapters, "")
    expect(model.rows.map(r => r.slug)).toEqual(["ready", "available", "supported"])
  })

  it("marks installable rows for available and supported harnesses", () => {
    const adapters = [
      adapter({ slug: "ready", status: "ready" }),
      adapter({ slug: "available", status: "available" }),
      adapter({ slug: "supported", status: "supported" }),
    ]
    const model = buildHarnessesWebviewModel(adapters, "")
    expect(model.rows.find(r => r.slug === "ready")?.installable).toBe(false)
    expect(model.rows.find(r => r.slug === "available")?.installable).toBe(true)
    expect(model.rows.find(r => r.slug === "supported")?.installable).toBe(true)
  })

  it("uses the real logo for known adapters and lettermark for unknowns", () => {
    const adapters = [adapter({ slug: "claude-code" }), adapter({ slug: "pi" })]
    const model = buildHarnessesWebviewModel(adapters, "")
    expect(model.rows.find(r => r.slug === "claude-code")?.logo).toEqual({ kind: "icon", file: "claude.svg" })
    expect(model.rows.find(r => r.slug === "pi")?.logo).toEqual({ kind: "lettermark", text: "π" })
  })

  it("filters by name, slug, and description", () => {
    const adapters = [
      adapter({ slug: "claude-code", name: "Claude Code", hint: "anthropic helper" }),
      adapter({ slug: "codex", name: "Codex", hint: "openai tool" }),
    ]
    expect(buildHarnessesWebviewModel(adapters, "openai").rows).toHaveLength(1)
    expect(buildHarnessesWebviewModel(adapters, "codex").rows).toHaveLength(1)
    expect(buildHarnessesWebviewModel(adapters, "helper").rows).toHaveLength(1)
    expect(buildHarnessesWebviewModel(adapters, "gemini").rows).toHaveLength(0)
  })

  it("reports shown and total counts", () => {
    const adapters = [adapter({ slug: "alpha" }), adapter({ slug: "beta" })]
    const model = buildHarnessesWebviewModel(adapters, "alpha")
    expect(model.shownCount).toBe(1)
    expect(model.totalCount).toBe(2)
  })

  it("prefers the adapter hint for the description", () => {
    const model = buildHarnessesWebviewModel([adapter({ hint: "custom hint" })], "")
    expect((model.rows[0] as HarnessWebviewRow).description).toBe("custom hint")
  })

  it("gives an installed (non-installable) harness the start action", () => {
    const model = buildHarnessesWebviewModel([adapter({ slug: "claude-code", status: "ready" })], "")
    expect(model.rows[0]?.action).toBe("start")
  })

  it("gives an installable harness the install action by default", () => {
    const model = buildHarnessesWebviewModel([adapter({ slug: "codex", status: "available" })], "")
    expect(model.rows[0]?.action).toBe("install")
  })

  it("gives an installable harness the installing action when its slug is in the optimistic set", () => {
    const model = buildHarnessesWebviewModel(
      [adapter({ slug: "codex", status: "available" })],
      "",
      new Set(["codex"]),
    )
    expect(model.rows[0]?.action).toBe("installing")
  })

  it("leaves other rows' actions untouched by an unrelated slug in the optimistic set", () => {
    const adapters = [adapter({ slug: "codex", status: "available" }), adapter({ slug: "claude-code", status: "ready" })]
    const model = buildHarnessesWebviewModel(adapters, "", new Set(["gemini-cli"]))
    expect(model.rows.find(r => r.slug === "codex")?.action).toBe("install")
    expect(model.rows.find(r => r.slug === "claude-code")?.action).toBe("start")
  })

  it("falls back to start once a previously-installing harness reports ready, ignoring the stale optimistic flag", () => {
    const model = buildHarnessesWebviewModel(
      [adapter({ slug: "codex", status: "ready" })],
      "",
      new Set(["codex"]),
    )
    expect(model.rows[0]?.action).toBe("start")
  })
})

describe("buildHarnessesWebviewModel — manifest facts + reach strip", () => {
  const anthropicSub = profile({ id: "sub", endpoint: "anthropic", method: "oauth-bearer", source: "claude-code-oauth" })
  const moonshotKey = profile({ id: "key", endpoint: "moonshot", method: "api-key" })

  it("carries manifest facts straight from the mind map's HarnessView", () => {
    const model = buildHarnessesWebviewModel(
      [claudeCodeAdapter],
      "",
      new Set(),
      [claudeCodeCap],
      [anthropicSub, moonshotKey],
      null,
    )
    const row = model.rows[0]!
    expect(row.manifest).toEqual({ speaks: "Anthropic", route: "free", acceptsBaseUrl: true })
  })

  it("matches reach() exactly for every provider in the strip — single source of truth", () => {
    const model = buildHarnessesWebviewModel(
      [claudeCodeAdapter],
      "",
      new Set(),
      [claudeCodeCap],
      [anthropicSub, moonshotKey],
      null,
    )
    const row = model.rows[0]!
    expect(row.reach.length).toBeGreaterThan(0)
    for (const entry of row.reach) {
      expect(entry.state).toBe(reach(claudeCodeAdapter, claudeCodeCap, entry.endpoint))
    }
    // anthropic is native, moonshot only reachable via the local router.
    expect(row.reach.find(e => e.endpoint === "anthropic")?.state).toBe("native")
    expect(row.reach.find(e => e.endpoint === "moonshot")?.state).toBe("via-router")
  })

  it("falls back to fixed/derived manifest facts and an empty reach strip when the daemon reports no capabilities", () => {
    const model = buildHarnessesWebviewModel([adapter({ slug: "unknown-harness" })], "", new Set(), [], [], null)
    const row = model.rows[0]!
    expect(row.manifest).toEqual({ speaks: "derived", route: "fixed", acceptsBaseUrl: false })
    expect(row.reach).toEqual([])
    expect(row.hiddenReachCount).toBe(0)
  })

  it("defaults capabilities/profiles/router so existing two-arg callers keep working", () => {
    const model = buildHarnessesWebviewModel([claudeCodeAdapter], "")
    // No profiles ⇒ buildProviders() has no provider columns ⇒ nothing to
    // reach, even though the adapter itself still resolves manifest facts.
    expect(model.rows[0]?.manifest).toEqual({ speaks: "Anthropic", route: "free", acceptsBaseUrl: true })
    expect(model.rows[0]?.reach).toEqual([])
  })
})
