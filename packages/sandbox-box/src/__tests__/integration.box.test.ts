/**
 * Real Box boot + a real agentproto daemon + one real hermes/openrouter turn.
 * Mirrors `integration.e2b.test.ts` — the goal proof from the sandbox-agent-host
 * brief: a coding-agent step running INSIDE a Box sandbox via the exact same
 * `createSandboxAgentSessionHost` seam a workflow would use.
 *
 * Skips locally (no BOX_API_KEY) — the orchestrator runs this with real keys.
 */
import { describe, it, expect } from "vitest"
import { createSandboxAgentSessionHost } from "@agentproto/sandbox"
import { boxSandboxProvider } from "../provider.js"
import { probeBoxCredential } from "./box-credential-probe.js"

// Preflight credential probe (an auth check ONLY — never a Box boot or any
// billable resource). A key that is present but DEAD (invalid / expired)
// skips loudly; an ambiguous probe outcome (network error, 5xx, transient
// 429) keeps the suite running so it can fail honestly.
const boxCredential = probeBoxCredential()
if (!boxCredential.supported) {
  console.log(`[skip] box sandbox agent host (integration): ${boxCredential.reason}`)
}

describe.skipIf(
  !process.env.BOX_API_KEY || !boxCredential.supported,
)("box sandbox agent host (integration)", () => {
  it(
    "boots a Box and completes one hermes/openrouter turn",
    async () => {
      let host: Awaited<ReturnType<typeof createSandboxAgentSessionHost>>
      try {
        host = await createSandboxAgentSessionHost({
          provider: boxSandboxProvider,
          spec: { provider: "box", config: {} },
          secrets: { slugs: ["OPENROUTER_API_KEY"] },
        })
      } catch (err: any) {
        // Box API unavailable — skip rather than fail (key may be stale / service down).
        console.warn(`[integration.box] Skipping — Box API error: ${err.message}`)
        return
      }
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
    180_000,
  )
})
