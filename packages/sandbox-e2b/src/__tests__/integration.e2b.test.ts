/**
 * Real e2b boot + a real agentproto daemon + one real hermes/openrouter turn.
 * This is the goal proof from the sandbox-agent-host brief: a coding-agent
 * step running INSIDE an e2b sandbox via the exact same
 * `createSandboxAgentSessionHost` seam a workflow would use.
 *
 * Skips locally (no E2B_API_KEY) — the orchestrator runs this with real
 * keys.
 */
import { describe, it, expect } from "vitest"
import { createSandboxAgentSessionHost } from "@agentproto/sandbox"
import { e2bSandboxProvider } from "../provider.js"

describe.skipIf(!process.env.E2B_API_KEY)("e2b sandbox agent host (integration)", () => {
  it(
    "boots the agentproto-workstation sandbox and completes one hermes/openrouter turn",
    async () => {
      const host = await createSandboxAgentSessionHost({
        provider: e2bSandboxProvider,
        spec: { provider: "e2b", config: {} },
        secrets: { slugs: ["OPENROUTER_API_KEY"] },
      })
      try {
        const sessionId = await host.spawn("hermes", {})
        await host.sendPromptAndWait(sessionId, "Reply with the single word OK. Nothing else.")
        if (host.readFinalMessage) {
          const message = await host.readFinalMessage(sessionId)
          expect(message.trim().toUpperCase()).toContain("OK")
        }
      } finally {
        await host.stop()
      }
    },
    120_000,
  )
})
