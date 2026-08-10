import { describe, it, expect } from "vitest"
import { hermes, hermesRuntime } from "../index.js"

describe("@agentproto/adapter-hermes", () => {
  it("exposes a validated AIP-45 handle", () => {
    expect(hermes.id).toBe("hermes")
    expect(hermes.protocol).toBe("acp")
    expect(hermes.acp).toBe("./hermes-acp.ACP.md")
    expect(hermes.bin).toBe("hermes")
    expect(hermes.bin_args).toEqual(["acp"])
  })

  it("declares ACP-compatible capabilities", () => {
    expect(hermes.capabilities?.streaming).toBe(true)
    expect(hermes.capabilities?.tool_calls).toBe(true)
    expect(hermes.capabilities?.bidirectional).toBe(true)
  })

  it("declares model routing slots", () => {
    // Cheap OpenRouter coder by default (hermes is the budget delegation arm).
    expect(hermes.models?.default).toBe("z-ai/glm-5.2@openrouter")
    // hermes ignores the ACP session model config — model is applied via a
    // `/model <id>` control turn (AgentCliModels.apply).
    expect(hermes.models?.apply).toBe("command")
  })

  it("reserves Anthropic models for the claude-code adapter", () => {
    // No anthropic env slot, no anthropic model on the menu, and a hard
    // deny so an explicit `anthropic/…` request is refused at compose time.
    expect(hermes.models?.env?.anthropic).toBeUndefined()
    expect(hermes.models?.allowed).not.toContain("anthropic/claude-opus-4-7")
    expect(hermes.models?.deny).toContain("anthropic/*")
    expect(hermes.models?.deny).toContain("claude-*")
  })

  it("generates OpenRouter model ids in canonical `vendor/product@route` format", () => {
    // Regression test for a format bug: generated OpenRouter entries must use
    // the `@openrouter` suffix (route-identity canonical form), NOT an
    // `openrouter/<vendor>/<id>` 3-segment prefix — the latter fails route
    // parsing. Note: `openrouter/auto@openrouter` is valid — the vendor name
    // IS "openrouter" there, so a bare startsWith check would false-positive.
    const allowed = hermes.models?.allowed ?? []
    const openrouterEntries = allowed.filter(
      (entry): entry is { id: string; provider: string } =>
        typeof entry !== "string" && entry.provider === "openrouter",
    )
    expect(openrouterEntries.length).toBeGreaterThan(0)
    for (const entry of openrouterEntries) {
      expect(entry.id).toMatch(/@openrouter$/)
      // Must be `vendor/product@openrouter` (2 segments before @), never
      // `openrouter/vendor/product` (3-segment prefix without @route suffix).
      const beforeRoute = entry.id.replace(/@openrouter$/, "")
      const segments = beforeRoute.split("/")
      expect(segments.length).toBeLessThanOrEqual(2)
    }
  })

  it("declares persistent session policy", () => {
    expect(hermes.session?.mode).toBe("persistent")
    expect(hermes.session?.idle_timeout_ms).toBe(1_800_000)
  })

  it("hermesRuntime returns a runtime bound to the hermes handle", () => {
    const runtime = hermesRuntime()
    expect(runtime.definition).toBe(hermes)
    expect(typeof runtime.start).toBe("function")
  })

  // Smoke test gated on HERMES_BIN — only runs on a developer's box
  // with hermes installed locally. Keeps CI green without skipping
  // the load-bearing real-spawn coverage.
  it.skipIf(!process.env.HERMES_BIN)(
    "spawns hermes and completes a turn",
    async () => {
      const runtime = hermesRuntime()
      const session = await runtime.start({
        env: {
          OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
        },
      })
      try {
        const events: string[] = []
        for await (const evt of session.send({
          role: "user",
          content: "say hello in one word",
        })) {
          events.push(evt.kind)
          if (evt.kind === "turn-end") break
        }
        expect(events).toContain("turn-end")
      } finally {
        await session.close()
      }
    },
    30_000,
  )
})
