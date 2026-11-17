import { describe, it, expect } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { cdContractLine } from "../agents-md.js"
import { parseRolePack } from "../role-pack.js"

function fakeSession(sent: string[]): AgentSessionLike {
  return {
    sessionId: "acp_test",
    async *send(message: unknown) {
      sent.push(typeof message === "string" ? message : String((message as { text?: unknown }).text ?? ""))
      yield { kind: "turn-end", reason: "completed" } as const
    },
    async cancel() {},
    async close() {},
  }
}

describe("spawnAgentSession: role contextFiles", () => {
  it("injects the repo map into the prompt of a `recherche` spawn, after the role disposition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "carte-"))
    try {
      const carte = join(dir, "carte-depots.md")
      await writeFile(carte, "| agentproto/agentproto | AIPs, specs |\n")
      const role = parseRolePack(
        `---\nrole: recherche\nlevel: 50\ntoolPolicy.delegation: deny\ncontextFiles: carte-depots=${carte}\n---\nTu fais l'inventaire d'abord.`,
      )
      const sent: string[] = []
      const registry = createSessionsRegistry({ persist: false })
      const deps: SpawnAgentSessionDeps = {
        registry,
        resolveAgentAdapter: async () =>
          ({ startSession: (async () => fakeSession(sent)) as any, commandPreview: "mock" }) as any,
        resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
        resolveWorkspaceRules: async () => ({}),
        daemonMcpUrl: "http://127.0.0.1:18790/mcp",
        loadRoleRegistry: async () => ({ recherche: role }),
      }
      const result = await spawnAgentSession(deps, {
        adapter: "opencode",
        cwd: "/tmp",
        role: "recherche",
        prompt: "Regarde globalement les preuves.",
        wait: true,
      })
      expect(result.ok).toBe(true)
      const initial = sent.join("\n")
      const iDispo = initial.indexOf("Tu fais l'inventaire d'abord.")
      const iCarte = initial.indexOf("<carte-depots>\n| agentproto/agentproto | AIPs, specs |")
      const iAsk = initial.indexOf("Regarde globalement les preuves.")
      expect(iDispo).toBeGreaterThanOrEqual(0)
      expect(iCarte).toBeGreaterThan(iDispo)
      expect(iAsk).toBeGreaterThan(iCarte)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
