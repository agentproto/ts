/**
 * `SessionsRegistry.recordNotice` — the generic display-only path a caller
 * with just a session id (no `rt` in hand) uses to stamp a daemon-authored
 * `notice` into an agent-cli session's transcript. Backs the review-runner's
 * settle notice (Goal A item 4 of the review-session-panel step): it must
 * land in `events.jsonl` (so `session_story`/`live_session` render it) and
 * must NEVER touch the inbox/promptQueue/`busy` — i.e. never wake an idle
 * session into a turn or interrupt a busy one.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { sessionEventsPath } from "../transcript-writer.js"

/** `createWriteStream`'s fd open is async, so a `recordNotice` call can
 *  return before the file exists on disk — poll instead of a fixed sleep. */
async function waitForEvents(sessionId: string, dir: string, timeoutMs = 2000): Promise<Array<Record<string, unknown>>> {
  const until = Date.now() + timeoutMs
  for (;;) {
    try {
      return readEvents(sessionId, dir)
    } catch {
      if (Date.now() > until) throw new Error(`events.jsonl for ${sessionId} never appeared in ${dir}`)
      await new Promise(r => setTimeout(r, 10))
    }
  }
}

function instantAgentSession(): AgentSessionLike {
  return {
    sessionId: "instant-session",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function readEvents(sessionId: string, dir: string): Array<Record<string, unknown>> {
  return readFileSync(sessionEventsPath(sessionId, dir), "utf8")
    .split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

describe("registry.recordNotice", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "record-notice-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("appends a `notice` event to events.jsonl and returns true", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    expect(registry.recordNotice(desc.id, "review pass ab12345..cd67890 (review-xyz)")).toBe(true)
    const events = await waitForEvents(desc.id, tmp)
    const notice = events.find(e => e.kind === "notice")
    expect(notice).toMatchObject({ kind: "notice", text: "review pass ab12345..cd67890 (review-xyz)" })
    registry.shutdown()
  })

  it("does not touch promptQueue, the inbox, or busy — no wake, no interrupt", () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    registry.recordNotice(desc.id, "review block cd67890..ef01234 (review-abc)")
    const after = registry.get(desc.id)!
    expect(after.busy).toBeFalsy()
    expect(after.promptQueue ?? []).toEqual([])
    expect(registry.listInbox(desc.id) ?? []).toEqual([])
    registry.shutdown()
  })

  it("returns false for an unknown session id, and for a non-agent-cli session", () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    expect(registry.recordNotice("sess_nope", "text")).toBe(false)
    const term = registry.spawn({ kind: "command", workspaceSlug: "default", argv: ["true"], cwd: "/tmp" })
    expect(registry.recordNotice(term.id, "text")).toBe(false)
    registry.shutdown()
  })
})
