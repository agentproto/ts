/**
 * P3 (#186) — non-claude adapters carry transcript usage.
 *
 * claude-code emits `usage_update` events inline over ACP, so its per-turn
 * token/cost telemetry lands in `events.jsonl`. hermes, by contrast, exposes
 * usage only through its `state.db` reader (`readHermesUsage`, wired as the
 * registry's `readUsage` hook). Before this fix that reader refreshed the
 * live descriptor but never recorded a stream event, so a hermes transcript
 * carried ZERO usage_update records.
 *
 * These tests mock the state.db read (the `readUsage` hook) and assert the
 * turn-end path now records a `usage_update` into the transcript — with the
 * SAME shape claude-code emits (size/used/cost + cumulative tokensIn/out).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { sessionEventsPath } from "../transcript-writer.js"

/** A hermes-shaped agent session: it streams NO usage over the wire (hermes'
 *  ACP server doesn't), only a turn-end. Usage arrives out-of-band via the
 *  registry's `readUsage` hook, exactly like the real state.db reader. */
function hermesAgentSession(): AgentSessionLike {
  return {
    sessionId: "hermes-adapter-sess",
    async *send() {
      yield { kind: "text-delta", text: "done\n" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

/** Read the transcript's usage_update records, retrying briefly so the
 *  append stream has flushed. */
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

describe("hermes usage_update from readUsage (P3 #186)", () => {
  let tmp: string
  let transcriptDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hermes-usage-test-"))
    transcriptDir = join(tmp, "sessions")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("records a usage_update carrying tokens (+ cost) from the state.db reader at turn-end", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: hermesAgentSession(),
      adapterSlug: "hermes",
      // Stand-in for readHermesUsage(sessionId) reading ~/.hermes/state.db.
      readUsage: async () => ({ costUsd: 0.0123, tokensIn: 1500, tokensOut: 800 }),
    })
    await registry.sendPrompt(desc.id, "hi")

    const updates = await readUsageUpdates(sessionEventsPath(desc.id, transcriptDir))
    expect(updates.length).toBeGreaterThanOrEqual(1)
    const evt = updates[updates.length - 1]!
    // Same envelope as claude-code's ACP usage_update: size/used present
    // (0 here — the reader carries no context window), cumulative tokens,
    // and an adapter-reported cost block.
    expect(evt).toMatchObject({
      kind: "usage_update",
      size: 0,
      used: 0,
      tokensIn: 1500,
      tokensOut: 800,
      cost: { amount: 0.0123, currency: "USD" },
    })

    // The live descriptor is tagged adapter-priced (the reader returned a cost).
    const live = registry.get(desc.id)
    expect(live?.tokensIn).toBe(1500)
    expect(live?.tokensOut).toBe(800)
    expect(live?.usageSource).toBe("adapter")

    registry.shutdown()
  })

  it("records a tokens-only usage_update (no cost block) when the reader reports no cost", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: hermesAgentSession(),
      adapterSlug: "hermes",
      // cost hasn't landed in state.db yet — tokens only.
      readUsage: async () => ({ tokensIn: 640, tokensOut: 128 }),
    })
    await registry.sendPrompt(desc.id, "hi")

    const updates = await readUsageUpdates(sessionEventsPath(desc.id, transcriptDir))
    const evt = updates[updates.length - 1]!
    expect(evt).toMatchObject({ kind: "usage_update", tokensIn: 640, tokensOut: 128 })
    expect("cost" in evt).toBe(false)

    registry.shutdown()
  })

  it("never fabricates a usage_update when the reader returns null", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: hermesAgentSession(),
      adapterSlug: "hermes",
      readUsage: async () => null,
    })
    await registry.sendPrompt(desc.id, "hi")

    // Give the append stream the same window the positive tests poll for,
    // then assert nothing usage_update-shaped was written.
    await new Promise(r => setTimeout(r, 200))
    const path = sessionEventsPath(desc.id, transcriptDir)
    const updates = existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map(line => JSON.parse(line) as Record<string, unknown>)
          .filter(r => r.kind === "usage_update")
      : []
    expect(updates).toHaveLength(0)

    registry.shutdown()
  })
})
