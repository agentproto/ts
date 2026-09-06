/**
 * Real e2b boot + a real agentproto daemon + one real hermes/openrouter turn.
 * This is the goal proof from the sandbox-agent-host brief: a coding-agent
 * step running INSIDE an e2b sandbox via the exact same
 * `createSandboxAgentSessionHost` seam a workflow would use.
 *
 * Skips locally (no E2B_API_KEY) — the orchestrator runs this with real
 * keys. Also skips at runtime if the key is invalid (403/401 from e2b).
 */
import { describe, it, expect } from "vitest"
import { createSandboxAgentSessionHost } from "@agentproto/sandbox"
import { e2bSandboxProvider } from "../provider.js"

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /40[13]/.test(msg) || /Forbidden/i.test(msg) || /Unauthorized/i.test(msg)
}

describe.skipIf(!process.env.E2B_API_KEY || !process.env.OPENROUTER_API_KEY)(
  "e2b sandbox agent host (integration)",
  () => {
    it(
      "boots the agentproto-workstation sandbox and completes one hermes/openrouter turn",
      async (ctx) => {
        let host: Awaited<ReturnType<typeof createSandboxAgentSessionHost>>
        try {
          host = await createSandboxAgentSessionHost({
            provider: e2bSandboxProvider,
            spec: {
              provider: "e2b",
              config: { installPackages: ["@agentproto/adapter-hermes"] },
            },
            secrets: { slugs: ["OPENROUTER_API_KEY"] },
          })
        } catch (err) {
          if (isAuthError(err)) {
            ctx.skip()
            return
          }
          throw err
        }
        try {
          const sessionId = await host.spawn("hermes", { cwd: "/home/user" })
          await host.sendPromptAndWait(sessionId, "Reply with the single word OK. Nothing else.")
          if (host.readFinalMessage) {
            const message = await host.readFinalMessage(sessionId)
            expect(message.trim().toUpperCase()).toContain("OK")
          }
        } finally {
          await host.stop()
        }
      },
      240_000,
    )
  },
)
