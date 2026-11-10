/**
 * Approval wake (`approvals/wake.ts`): a human decision re-prompts the session
 * or agent label that asked for it, instead of leaving it to poll.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createSessionEventBus } from "../session-event-bus.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { wireApprovalWake, type ApprovalWakeRegistry } from "../approvals/wake.js"
import type { SessionDescriptor } from "../sessions.js"
import type { SessionMessage } from "../session-message.js"

let home: string
let engine: ApprovalsEngine
let sessions: Map<string, Partial<SessionDescriptor>>
let sent: Array<{ to: string; text: string }>

const evidence = { ipAddress: "1.2.3.4", userAgent: "test" }

function live(id: string, label: string, startedAt: string): Partial<SessionDescriptor> {
  return { id, label, operatorLabel: label, status: "running", startedAt }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "approvals-wake-"))
  sessions = new Map()
  sent = []
  const bus = createSessionEventBus()
  engine = createApprovalsEngine({ homeDir: home, sessionEvents: bus, webOrigins: ["https://web.example.invalid"] })
  const registry: ApprovalWakeRegistry = {
    get: id => sessions.get(id) as SessionDescriptor | undefined,
    list: () => [...sessions.values()] as SessionDescriptor[],
    sendMessage: async (msg: SessionMessage) => {
      sent.push({ to: msg.to, text: msg.text })
    },
  }
  wireApprovalWake({ registry, sessionEvents: bus, getApproval: id => engine.get(id) })
})

afterEach(() => {
  engine.dispose()
  rmSync(home, { recursive: true, force: true })
})

const ask = (wake?: { sessionId?: string; agent?: string }) =>
  engine.request(
    { kind: "jobkit.submit", title: "Submit the Brevo form", preview: {}, payload: { x: 1 }, ...(wake ? { wake } : {}) },
    { operator: true },
  )

describe("approval wake", () => {
  it("approved: the requesting session is re-prompted with the approval id and verdict", async () => {
    sessions.set("sess_a", live("sess_a", "emploi", "2026-11-10T10:00:00Z"))
    const rec = ask({ sessionId: "sess_a" })

    await engine.decideWeb(rec.id, "approve", evidence)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe("sess_a")
    expect(sent[0]!.text).toContain(`[Approbation ${rec.id} décidée : approved]`)
  })

  it("denied: the verdict reads refused", async () => {
    sessions.set("sess_a", live("sess_a", "emploi", "2026-11-10T10:00:00Z"))
    const rec = ask({ sessionId: "sess_a" })

    await engine.decideWeb(rec.id, "deny", evidence)

    expect(sent[0]!.text).toContain(`[Approbation ${rec.id} décidée : refused]`)
  })

  it("the requester was replaced since the request: its successor hears the decision", async () => {
    sessions.set("sess_old", { ...live("sess_old", "emploi", "2026-11-10T10:00:00Z"), status: "killed", continuedTo: "sess_new" })
    sessions.set("sess_new", live("sess_new", "emploi", "2026-11-10T12:00:00Z"))
    const rec = ask({ sessionId: "sess_old" })

    await engine.decideWeb(rec.id, "approve", evidence)

    expect(sent.map(s => s.to)).toEqual(["sess_new"])
  })

  it("an agent label resolves at decision time to the newest live session", async () => {
    sessions.set("sess_1", live("sess_1", "pygmalion-agent-emploi", "2026-11-10T10:00:00Z"))
    const rec = ask({ agent: "Pygmalion-Agent-Emploi" })
    sessions.set("sess_2", live("sess_2", "pygmalion-agent-emploi", "2026-11-10T12:00:00Z"))

    await engine.decideWeb(rec.id, "approve", evidence)

    expect(sent.map(s => s.to)).toEqual(["sess_2"])
  })

  it("no wake target, or no live target: nothing is sent", async () => {
    sessions.set("sess_a", live("sess_a", "emploi", "2026-11-10T10:00:00Z"))
    await engine.decideWeb(ask().id, "approve", evidence)

    sessions.set("sess_dead", { ...live("sess_dead", "gone", "2026-11-10T10:00:00Z"), status: "killed" })
    await engine.decideWeb(ask({ sessionId: "sess_dead" }).id, "approve", evidence)

    expect(sent).toHaveLength(0)
  })

  it("the wake target is persisted on the approval record", () => {
    const rec = ask({ sessionId: "sess_a" })
    expect(engine.get(rec.id)?.wake).toEqual({ sessionId: "sess_a" })
  })
})
