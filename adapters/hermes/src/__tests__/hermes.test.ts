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
    expect(hermes.models?.default).toMatch(/anthropic|claude/)
    expect(hermes.models?.env?.anthropic).toBe("ANTHROPIC_API_KEY")
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
