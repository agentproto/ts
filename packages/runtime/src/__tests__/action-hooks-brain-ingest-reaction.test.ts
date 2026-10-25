/**
 * The brain-ingest pilot reaction: ownership filter, occurrence id, and the
 * mapping from `IngestResult` onto the runner outcome. No real brain here.
 */

import { describe, expect, it, vi } from "vitest"

import type { SessionCompletedEvent, SessionEvent } from "../session-event-bus.js"
import type { BrainManager, IngestResult } from "@agentproto/workspace-brain"
import {
  BRAIN_INGEST_ACTION_ID,
  BRAIN_INGEST_BINDING_ID,
  createBrainIngestReaction,
} from "../action-hooks/brain-ingest-reaction.js"

const completed = (over: Partial<SessionCompletedEvent> = {}): SessionCompletedEvent => ({
  type: "agentproto:session-completed",
  sessionId: "sess-1",
  occurrenceId: "exit:1",
  basis: "outcome",
  endedAt: "2026-01-01T00:00:00.000Z",
  ts: "2026-01-01T00:00:00.000Z",
  ...over,
})

function fakes(result?: IngestResult | Error) {
  const ingestSession = vi.fn(async (): Promise<IngestResult> => {
    if (result instanceof Error) throw result
    return result ?? { sessionId: "sess-1", ok: true, sourceId: "sess-1" }
  })
  const resolveWorkspace = vi.fn(async (): Promise<string | undefined> => "ws-a")
  const getBrain = vi.fn(() => ({ ingestSession }) as unknown as BrainManager)
  const brains = { getBrain, resolveWorkspace }
  return { brains, ingestSession, resolveWorkspace, getBrain }
}

const targetInput = (sessionId = "sess-1") => ({
  receiptKey: `k/${sessionId}`,
  sessionId,
  event: "agentproto:session-completed",
  occurrenceId: "exit:1",
  bindingId: BRAIN_INGEST_BINDING_ID,
  reactionDepth: 0,
})

describe("createBrainIngestReaction", () => {
  it("stamps the binding ids and the stable config revision", () => {
    const { brains } = fakes()
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => ["ws-a"] })
    expect(reaction.binding.bindingId).toBe(BRAIN_INGEST_BINDING_ID)
    expect(reaction.binding.actionId).toBe(BRAIN_INGEST_ACTION_ID)
    expect(reaction.binding.event).toBe("agentproto:session-completed")
    expect(reaction.binding.configRevision).toBe("brain-ingest-v1")
    expect(reaction.binding.reactionDepth).toBe(0)
    expect(reaction.binding.maxAttempts).toBe(3)
    expect(reaction.binding.target.idempotent).toBe(true)
  })

  it("returns the event occurrence id only for the session-completed event", () => {
    const { brains } = fakes()
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => ["ws-a"] })
    expect(reaction.binding.occurrenceIdOf(completed({ occurrenceId: "exit:9" }))).toBe("exit:9")
    const other = { type: "session:exited", sessionId: "sess-1", exitCode: 0, status: "exited", ts: "x" } as SessionEvent
    expect(reaction.binding.occurrenceIdOf(other)).toBeUndefined()
  })

  it("shouldHandle is false for a resolved non-owned workspace", async () => {
    const { brains, resolveWorkspace } = fakes()
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => ["ws-a"] })
    resolveWorkspace.mockResolvedValueOnce("ws-b")
    expect(await reaction.binding.shouldHandle!(completed())).toBe(false)
  })

  it("shouldHandle is true for an owned workspace", async () => {
    const { brains } = fakes()
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => ["ws-a"] })
    expect(await reaction.binding.shouldHandle!(completed())).toBe(true)
  })

  it("shouldHandle is false for an unresolved workspace (the legacy subscriber skips it too)", async () => {
    const { brains, resolveWorkspace } = fakes()
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => ["ws-a"] })
    resolveWorkspace.mockResolvedValueOnce(undefined)
    expect(await reaction.binding.shouldHandle!(completed())).toBe(false)
  })

  it("an empty owned list is false without resolving anything, owned or unresolved", async () => {
    const { brains, resolveWorkspace } = fakes()
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => [] })
    expect(await reaction.binding.shouldHandle!(completed())).toBe(false)
    resolveWorkspace.mockResolvedValueOnce(undefined)
    expect(await reaction.binding.shouldHandle!(completed())).toBe(false)
    expect(resolveWorkspace).not.toHaveBeenCalled()
  })

  it("owns reflects the injected list at call time", async () => {
    const { brains } = fakes()
    let owned: string[] = ["ws-a"]
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => owned })
    expect(await reaction.owns("ws-a")).toBe(true)
    owned = ["ws-b"]
    expect(await reaction.owns("ws-a")).toBe(false)
    expect(await reaction.owns("ws-b")).toBe(true)
  })

  it("maps a successful ingest to brain:<workspace>:<session>", async () => {
    const { brains, ingestSession } = fakes({ sessionId: "sess-1", ok: true, sourceId: "sess-1" })
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => ["ws-a"] })
    expect(await reaction.binding.target.run(targetInput())).toEqual({
      ok: true,
      outcomeRef: "brain:ws-a:sess-1",
    })
    expect(ingestSession).toHaveBeenCalledWith("sess-1")
  })

  it("maps already-ingested to the same brain outcome", async () => {
    const { brains } = fakes({ sessionId: "sess-1", ok: true, skipped: "already-ingested" })
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => ["ws-a"] })
    expect(await reaction.binding.target.run(targetInput())).toEqual({
      ok: true,
      outcomeRef: "brain:ws-a:sess-1",
    })
  })

  it("maps a skippedReason to a successful skipped outcome", async () => {
    const { brains } = fakes({ sessionId: "sess-1", ok: false, skippedReason: "no-transcript" })
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => ["ws-a"] })
    expect(await reaction.binding.target.run(targetInput())).toEqual({
      ok: true,
      outcomeRef: "skipped:no-transcript",
    })
  })

  it("maps a pipeline error to a retryable failure", async () => {
    const { brains } = fakes({ sessionId: "sess-1", ok: false, error: "disk full" })
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => ["ws-a"] })
    expect(await reaction.binding.target.run(targetInput())).toEqual({
      ok: false,
      retryable: true,
      error: "disk full",
    })
  })

  it("lets a thrown ingest propagate (the runner treats it as retryable)", async () => {
    const { brains } = fakes(new Error("boom"))
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => ["ws-a"] })
    await expect(reaction.binding.target.run(targetInput())).rejects.toThrow("boom")
  })

  it("a workspace that is no longer owned is skipped, not ingested", async () => {
    const { brains, ingestSession } = fakes()
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => ["ws-b"] })
    expect(await reaction.binding.target.run(targetInput())).toEqual({
      ok: true,
      outcomeRef: "skipped:not-owner",
    })
    expect(ingestSession).not.toHaveBeenCalled()
  })

  it("an unresolved workspace is a non-retryable failure", async () => {
    const { brains, resolveWorkspace } = fakes()
    resolveWorkspace.mockResolvedValueOnce(undefined)
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => ["ws-a"] })
    expect(await reaction.binding.target.run(targetInput())).toEqual({
      ok: false,
      retryable: false,
      error: "workspace_unresolved",
    })
  })
})
