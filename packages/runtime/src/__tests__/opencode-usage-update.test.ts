/**
 * opencode's live ACP `usage_update` event only ever carries
 * `{used, size, cost}` — no token fields exist on that wire event at all
 * (confirmed by disassembling the installed opencode acp binary). Before
 * this fix, `session_usage`/`usage_rollup` therefore never saw
 * tokensIn/tokensOut for opencode sessions, only costUsd/contextUsed.
 *
 * The fix mirrors hermes (see hermes-usage-update.test.ts): a `readUsage`
 * hook — `readOpenCodeUsage` in `@agentproto/adapter-opencode`, reading
 * opencode's own `opencode.db` sqlite store — is wired into the registry's
 * turn-end path (packages/cli/src/commands/serve.ts) alongside the live
 * ACP arm, the same generic mechanism these tests exercise for hermes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { sessionEventsPath } from "../transcript-writer.js"

/** An opencode-shaped agent session: streams the live ACP `usage_update`
 *  shape opencode actually sends — `{used, size, cost}`, no token fields —
 *  then a turn-end. Tokens arrive out-of-band via the registry's
 *  `readUsage` hook, exactly like the real opencode.db reader. */
function opencodeAgentSession(): AgentSessionLike {
  return {
    sessionId: "opencode-adapter-sess",
    async *send() {
      yield { kind: "text-delta", text: "done\n" }
      yield { kind: "usage_update", used: 12000, size: 200000, cost: { amount: 0.0456, currency: "USD" } }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

async function readUsageUpdates(
  path: string,
): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (existsSync(path)) {
      const records = readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .filter(r => r.kind === "usage_update")
      if (records.length > 0) return records
    }
    await new Promise(r => setTimeout(r, 25))
  }
  return []
}

describe("opencode usage_update from readUsage", () => {
  let tmp: string
  let transcriptDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "opencode-usage-test-"))
    transcriptDir = join(tmp, "sessions")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("fills in tokensIn/tokensOut from the opencode.db reader even though the live ACP event carried none", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: opencodeAgentSession(),
      adapterSlug: "opencode",
      // Stand-in for readOpenCodeUsage(sessionId) reading opencode.db.
      readUsage: async () => ({ costUsd: 0.0456, tokensIn: 9927, tokensOut: 87 }),
    })
    await registry.sendPrompt(desc.id, "hi")

    const updates = await readUsageUpdates(sessionEventsPath(desc.id, transcriptDir))
    expect(updates.length).toBeGreaterThanOrEqual(2)

    // The live ACP arm's own usage_update (context tracking, no tokens).
    const acpEvt = updates.find(u => u.used === 12000)
    expect(acpEvt).toMatchObject({ kind: "usage_update", size: 200000, used: 12000 })
    expect(acpEvt).not.toHaveProperty("tokensIn")

    // The readUsage-hook's usage_update carries the tokens the live event lacked.
    const readerEvt = updates[updates.length - 1]!
    expect(readerEvt).toMatchObject({
      kind: "usage_update",
      tokensIn: 9927,
      tokensOut: 87,
      cost: { amount: 0.0456, currency: "USD" },
    })

    const live = registry.get(desc.id)
    expect(live?.tokensIn).toBe(9927)
    expect(live?.tokensOut).toBe(87)
    expect(live?.usageSource).toBe("adapter")

    registry.shutdown()
  })

  it("never fabricates tokens when the reader returns null (falls back to cost-only, matching pre-fix behavior)", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: opencodeAgentSession(),
      adapterSlug: "opencode",
      readUsage: async () => null,
    })
    await registry.sendPrompt(desc.id, "hi")

    const live = registry.get(desc.id)
    expect(live?.tokensIn).toBeUndefined()
    expect(live?.tokensOut).toBeUndefined()
    expect(live?.costUsd).toBe(0.0456)

    registry.shutdown()
  })
})
