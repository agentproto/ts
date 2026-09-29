/**
 * Approvals engine — gate semantics, ticket handling, signature/audit
 * chain, and restart persistence. Ports the Pygmalion M1 gate reference's
 * test semantics (`projects/pygmalion/packages/core/src/__tests__/gate.test.ts`
 * in the studio repo) onto `ApprovalsEngine`, plus the AIP-7 signing layer
 * the engine adds on top.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { verifyChain } from "@agentproto/governance/hash-chain"

import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { ApprovalError, ApprovalNotPendingError, CardTicketError, CARD_TICKET_TTL_MS } from "../approvals/types.js"
import { resolveApprovalsGovernanceConfig } from "../approvals/governance.js"

let home: string
let events: SessionEvent[]
let engine: ApprovalsEngine

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "approvals-engine-"))
  events = []
  const bus = createSessionEventBus()
  bus.onAny(e => events.push(e))
  engine = createApprovalsEngine({ homeDir: home, sessionEvents: bus, webOrigins: ["https://web.example.invalid"] })
})

afterEach(() => {
  engine.dispose()
  rmSync(home, { recursive: true, force: true })
})

const preview = { to: "you@example.invalid", subject: "Test invoice" }
const requester = { sessionId: "sess_abc" }

describe("ApprovalsEngine: what is approved is what is consumed", () => {
  it("(a) consuming without any decision throws approval_not_approved", () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    expect(record.status).toBe("pending")

    expect(() => engine.consume(record.id, requester, payload)).toThrowError(
      expect.objectContaining({ name: "ApprovalError", code: "approval_not_approved" }),
    )
  })

  it("(b) a denied approval throws approval_not_approved when consumed", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    const decided = await engine.decideWeb(record.id, "deny", { ipAddress: "1.2.3.4", userAgent: "test" })
    expect(decided.status).toBe("denied")

    expect(() => engine.consume(record.id, requester, payload)).toThrowError(
      expect.objectContaining({ code: "approval_not_approved" }),
    )
  })

  it("(c) a second consume throws approval_already_consumed", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    await engine.decideWeb(record.id, "approve", { ipAddress: "1.2.3.4", userAgent: "test" })

    engine.consume(record.id, requester, payload)
    expect(() => engine.consume(record.id, requester, payload)).toThrowError(
      expect.objectContaining({ code: "approval_already_consumed" }),
    )
  })

  it("(d) a payload changed after approval throws payload_mismatch", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    await engine.decideWeb(record.id, "approve", { ipAddress: "1.2.3.4", userAgent: "test" })

    const tampered = { to: "evil@example.invalid", subject: "hi" }
    expect(() => engine.consume(record.id, requester, tampered)).toThrowError(
      expect.objectContaining({ code: "payload_mismatch" }),
    )
  })

  it("not_requester: only the original requester (or the operator) may consume", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    await engine.decideWeb(record.id, "approve", { ipAddress: "1.2.3.4", userAgent: "test" })

    expect(() => engine.consume(record.id, { sessionId: "sess_other" }, payload)).toThrowError(
      expect.objectContaining({ code: "not_requester" }),
    )
    // The rightful requester still succeeds.
    expect(() => engine.consume(record.id, requester, payload)).not.toThrow()
  })

  it("the operator may consume an operator-made request; a session may not", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, { operator: true })
    await engine.decideWeb(record.id, "approve", { ipAddress: "1.2.3.4", userAgent: "test" })

    expect(() => engine.consume(record.id, requester, payload)).toThrowError(
      expect.objectContaining({ code: "not_requester" }),
    )
    expect(() => engine.consume(record.id, { operator: true }, payload)).not.toThrow()
  })

  it("expired: a request past its expiresAt refuses consume with approval_expired", () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request(
      { kind: "send", title: "Send", preview, payload, expiresAt: new Date(Date.now() - 1000).toISOString() },
      requester,
    )
    // Lazy expiry: the next read/mutate flips it.
    expect(engine.get(record.id)?.status).toBe("expired")
    expect(() => engine.consume(record.id, requester, payload)).toThrowError(
      expect.objectContaining({ code: "approval_expired" }),
    )
    const expiredEvent = events.find(e => e.type === "approval:expired")
    expect(expiredEvent).toMatchObject({ approvalId: record.id })
  })

  it("approval_not_found for a bogus id", () => {
    expect(() => engine.consume("apr_does_not_exist", requester, {})).toThrowError(
      expect.objectContaining({ code: "approval_not_found" }),
    )
  })
})

describe("ApprovalsEngine: signature + audit chain (AIP-7)", () => {
  it("an approve writes a signature whose documentHash equals payloadHash, and the audit chain verifies", async () => {
    const payload = { to: "a@example.invalid", subject: "hi", amount: 42 }
    const record = engine.request({ kind: "spend", title: "Pay", preview, payload }, requester)
    const decided = await engine.decideWeb(record.id, "approve", { ipAddress: "9.9.9.9", userAgent: "vitest" })

    expect(decided.decision?.signaturePath).toBeDefined()
    const sigAbs = join(home, decided.decision!.signaturePath!)
    const sig = JSON.parse(readFileSync(sigAbs, "utf8")) as {
      documentHash: string
      signerKind: string
      method: string
      evidence: { kind: string; signedUrlToken: string }
    }
    expect(sig.documentHash).toBe(record.payloadHash)
    expect(sig.signerKind).toBe("user")
    expect(sig.method).toBe("click_through")
    expect(sig.evidence.kind).toBe("click_through")

    const config = resolveApprovalsGovernanceConfig(home)
    const log = readFileSync(join(home, "audit", "audit-log.jsonl"), "utf8")
    const result = verifyChain(log, { secret: config.hmacSecret, genesisSeed: config.genesisSeed })
    expect(result.ok).toBe(true)
  })

  it("a deny writes an audit event but no signature", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    const decided = await engine.decideWeb(record.id, "deny", { ipAddress: "9.9.9.9", userAgent: "vitest" })
    expect(decided.decision?.signaturePath).toBeUndefined()

    const config = resolveApprovalsGovernanceConfig(home)
    const log = readFileSync(join(home, "audit", "audit-log.jsonl"), "utf8")
    const result = verifyChain(log, { secret: config.hmacSecret, genesisSeed: config.genesisSeed })
    expect(result.ok).toBe(true)
    expect(log).toContain("approval.denied")
  })

  it("mutation check: a broken chain must be caught by the verifier", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    await engine.decideWeb(record.id, "approve", { ipAddress: "9.9.9.9", userAgent: "vitest" })

    const config = resolveApprovalsGovernanceConfig(home)
    const logPath = join(home, "audit", "audit-log.jsonl")
    const original = readFileSync(logPath, "utf8")
    const tampered = original.replace('"signature.created"', '"signature.tampered"')
    expect(tampered).not.toBe(original)

    const brokenResult = verifyChain(tampered, { secret: config.hmacSecret, genesisSeed: config.genesisSeed })
    expect(brokenResult.ok).toBe(false)

    // Restore — the real chain still verifies (documents that the break
    // above was a genuine detection, not a false negative in the verifier).
    const restoredResult = verifyChain(original, { secret: config.hmacSecret, genesisSeed: config.genesisSeed })
    expect(restoredResult.ok).toBe(true)
  })
})

describe("ApprovalsEngine: web_click channel gating", () => {
  it("decideWeb refuses a channel the request didn't declare", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request(
      { kind: "send", title: "Send", preview, payload, channels: ["ui_card"] },
      requester,
    )
    await expect(
      engine.decideWeb(record.id, "approve", { ipAddress: "1.2.3.4", userAgent: "test" }),
    ).rejects.toThrow('channel "web_click" is not allowed')
  })

  it("web_click is excluded from enabledChannels when no webOrigins are configured", () => {
    const bus = createSessionEventBus()
    const offEngine = createApprovalsEngine({ homeDir: home + "-off", sessionEvents: bus })
    expect(offEngine.enabledChannels).toEqual(["ui_card"])
    offEngine.dispose()
  })
})

describe("ApprovalsEngine: card tickets (ui_card channel)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("mint then decide approve: approved via ui_card, signature recorded", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)

    const { ticket } = engine.mintCardTicket(record.id)
    const decided = await engine.decideByCard(record.id, "approve", ticket, {
      ipAddress: "mcp-app",
      userAgent: "mcp-app",
    })
    expect(decided.status).toBe("approved")
    expect(decided.decision?.channel).toBe("ui_card")
    expect(decided.decision?.signaturePath).toBeDefined()
  })

  it("refuses with no ticket ever minted, approval stays pending", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)

    await expect(
      engine.decideByCard(record.id, "approve", "not-a-real-ticket", { ipAddress: "x", userAgent: "x" }),
    ).rejects.toBeInstanceOf(CardTicketError)
    expect(engine.get(record.id)?.status).toBe("pending")
  })

  it("refuses a wrong ticket, and burns the real one so it can't be retried", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    const { ticket } = engine.mintCardTicket(record.id)

    await expect(
      engine.decideByCard(record.id, "approve", "wrong-guess", { ipAddress: "x", userAgent: "x" }),
    ).rejects.toBeInstanceOf(CardTicketError)
    expect(engine.get(record.id)?.status).toBe("pending")

    await expect(
      engine.decideByCard(record.id, "approve", ticket, { ipAddress: "x", userAgent: "x" }),
    ).rejects.toBeInstanceOf(CardTicketError)
    expect(engine.get(record.id)?.status).toBe("pending")
  })

  it("refuses a ticket minted for another approval", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const recordA = engine.request({ kind: "send", title: "Send A", preview, payload }, requester)
    const recordB = engine.request({ kind: "send", title: "Send B", preview, payload: { ...payload, x: 1 } }, requester)
    const { ticket: ticketB } = engine.mintCardTicket(recordB.id)

    await expect(
      engine.decideByCard(recordA.id, "approve", ticketB, { ipAddress: "x", userAgent: "x" }),
    ).rejects.toBeInstanceOf(CardTicketError)
    expect(engine.get(recordA.id)?.status).toBe("pending")
  })

  it("refuses an expired ticket", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    const { ticket } = engine.mintCardTicket(record.id)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + CARD_TICKET_TTL_MS + 1000)

    await expect(
      engine.decideByCard(record.id, "approve", ticket, { ipAddress: "x", userAgent: "x" }),
    ).rejects.toBeInstanceOf(CardTicketError)
    expect(engine.get(record.id)?.status).toBe("pending")
  })

  it("refuses a reused ticket: the second attempt does not re-decide the approval", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    const { ticket } = engine.mintCardTicket(record.id)

    const first = await engine.decideByCard(record.id, "approve", ticket, { ipAddress: "x", userAgent: "x" })
    expect(first.status).toBe("approved")

    await expect(
      engine.decideByCard(record.id, "deny", ticket, { ipAddress: "x", userAgent: "x" }),
    ).rejects.toBeInstanceOf(CardTicketError)
    expect(engine.get(record.id)?.status).toBe("approved")
  })

  it("refuses a ticket for an approval already decided on the web", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    const { ticket } = engine.mintCardTicket(record.id)

    await engine.decideWeb(record.id, "approve", { ipAddress: "1.2.3.4", userAgent: "test" })

    await expect(
      engine.decideByCard(record.id, "deny", ticket, { ipAddress: "x", userAgent: "x" }),
    ).rejects.toBeInstanceOf(ApprovalNotPendingError)
    expect(engine.get(record.id)?.status).toBe("approved")
    expect(engine.get(record.id)?.decision?.channel).toBe("web_click")
  })

  it("minting again for the same approval invalidates the earlier ticket", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    const first = engine.mintCardTicket(record.id)
    const second = engine.mintCardTicket(record.id)
    expect(second.ticket).not.toBe(first.ticket)

    // The fresh (second) ticket decides successfully — proves the mint
    // replaced the stored record, not merely returned a new string.
    const decided = await engine.decideByCard(record.id, "approve", second.ticket, {
      ipAddress: "x",
      userAgent: "x",
    })
    expect(decided.status).toBe("approved")
  })

  it("the superseded ticket no longer decides (a wrong attempt with it burns whatever is current)", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    const first = engine.mintCardTicket(record.id)
    engine.mintCardTicket(record.id) // supersedes `first`

    await expect(
      engine.decideByCard(record.id, "approve", first.ticket, { ipAddress: "x", userAgent: "x" }),
    ).rejects.toBeInstanceOf(CardTicketError)
    expect(engine.get(record.id)?.status).toBe("pending")
  })

  it("mintCardTicket refuses for a non-pending approval, and for one that doesn't exist", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    await engine.decideWeb(record.id, "deny", { ipAddress: "1.2.3.4", userAgent: "test" })

    expect(() => engine.mintCardTicket(record.id)).toThrowError(ApprovalNotPendingError)
    expect(() => engine.mintCardTicket("apr_does_not_exist")).toThrowError(ApprovalError)
  })
})

describe("ApprovalsEngine: restart persistence", () => {
  it("a pending request survives a restart and can still be decided", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    engine.dispose()

    const bus2 = createSessionEventBus()
    const reloaded = createApprovalsEngine({
      homeDir: home,
      sessionEvents: bus2,
      webOrigins: ["https://web.example.invalid"],
    })
    expect(reloaded.get(record.id)?.status).toBe("pending")

    const decided = await reloaded.decideWeb(record.id, "approve", { ipAddress: "1.2.3.4", userAgent: "test" })
    expect(decided.status).toBe("approved")
    reloaded.dispose()
  })

  it("consumed state survives a restart", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    await engine.decideWeb(record.id, "approve", { ipAddress: "1.2.3.4", userAgent: "test" })
    engine.consume(record.id, requester, payload)
    engine.dispose()

    const bus2 = createSessionEventBus()
    const reloaded = createApprovalsEngine({ homeDir: home, sessionEvents: bus2 })
    expect(reloaded.get(record.id)?.status).toBe("consumed")
    expect(() => reloaded.consume(record.id, requester, payload)).toThrowError(
      expect.objectContaining({ code: "approval_already_consumed" }),
    )
    reloaded.dispose()
  })
})

describe("ApprovalsEngine: events", () => {
  it("fires approval:requested, approval:decided, approval:consumed", async () => {
    const payload = { to: "a@example.invalid", subject: "hi" }
    const record = engine.request({ kind: "send", title: "Send", preview, payload }, requester)
    await engine.decideWeb(record.id, "approve", { ipAddress: "1.2.3.4", userAgent: "test" })
    engine.consume(record.id, requester, payload)

    expect(events.find(e => e.type === "approval:requested")).toMatchObject({ approvalId: record.id })
    expect(events.find(e => e.type === "approval:decided")).toMatchObject({
      approvalId: record.id,
      decision: "approved",
      channel: "web_click",
    })
    expect(events.find(e => e.type === "approval:consumed")).toMatchObject({ approvalId: record.id })
  })
})
