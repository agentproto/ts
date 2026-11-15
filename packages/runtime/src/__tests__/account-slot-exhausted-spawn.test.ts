/**
 * `agent_start` on a slot whose every account is exhausted refuses with the
 * typed `account_slot_exhausted` error and the nearest return time, before any
 * adapter starts. A caller can then say "back at ...", not just "failed".
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { addAuthProfile } from "@agentproto/auth"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike, type SessionsRegistry } from "../sessions.js"
import { createAccountHealthStore } from "../account-health.js"
import { cdContractLine } from "../agents-md.js"

const T0 = Date.parse("2026-11-15T10:00:00Z")
const H = 3_600_000

describe("agent_start on an exhausted account slot", () => {
  let dir: string
  let registry: SessionsRegistry
  let deps: SpawnAgentSessionDeps
  const startSession = vi.fn(
    async (): Promise<AgentSessionLike> => ({
      sessionId: "x",
      // eslint-disable-next-line require-yield
      async *send() {
        return
      },
      async cancel() {},
      async close() {},
    }),
  )

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agp-slot-spawn-"))
    startSession.mockClear()
    await addAuthProfile({ id: "ws01", endpoint: "anthropic", method: "api-key" })
    await addAuthProfile({ id: "ws003", endpoint: "anthropic", method: "api-key" })
    registry = createSessionsRegistry({ persist: false })
    deps = {
      registry,
      accountHealth: createAccountHealthStore({ dir, now: () => T0 }),
      loadAccountSlots: async () => ({ "opencode-go": ["ws01", "ws003"] }),
      resolveAgentAdapter: async () => ({
        commandPreview: "mock",
        startSession: startSession as unknown as (opts: unknown) => Promise<AgentSessionLike>,
      }),
      resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
      resolveWorkspaceRules: async () => ({}),
    }
  })
  afterEach(async () => {
    registry.shutdown()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it("refuses with account_slot_exhausted and the nearest retryAfter; nothing starts", async () => {
    await deps.accountHealth!.mark("ws01", { reason: "402", until: T0 + 30 * H, untilBasis: "observed" })
    await deps.accountHealth!.mark("ws003", { reason: "402", until: T0 + 6 * H, untilBasis: "observed" })
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      access: { profileRef: "slot:opencode-go" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("account_slot_exhausted")
    expect(result.details).toMatchObject({ slot: "opencode-go", retryAfter: new Date(T0 + 6 * H).toISOString() })
    expect(result.message).toMatch(/every account of the slot is exhausted/)
    expect(startSession).not.toHaveBeenCalled()
  })
})
