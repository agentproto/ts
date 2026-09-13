/**
 * Conformity test for the RAW daemon-transcript → AI-SDK `UIMessageChunk`
 * mapper behind `POST /sessions/:id/chat` and `POST /sessions/chat`.
 *
 * Replays the CANONICAL_SESSION_RECORDS fixture from
 * `@agentproto/transcript-fixtures` in `seq` order through
 * `createTranscriptToUiMapper` (the pure function the routes call) and asserts
 * the exact chunk sequence for every record — including the fixture's `notice`
 * (an unknown kind) producing an explicit `error` chunk AND a server-side
 * `console.error` (CONDITION 2), and `permission-resolved` producing the
 * custom `data-tool-call-approval` data part (CONDITION 4).
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  CANONICAL_SESSION_ID,
  CANONICAL_SESSION_RECORDS,
} from "@agentproto/transcript-fixtures"
import { createTranscriptToUiMapper } from "../chat-stream.js"

const T1 = `${CANONICAL_SESSION_ID}::assistant-turn-1`

afterEach(() => {
  vi.restoreAllMocks()
})

describe("transcript → UIMessageChunk mapping against CANONICAL_SESSION_RECORDS", () => {
  it("asserts every record's mapping precisely (per-record + flattened)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const map = createTranscriptToUiMapper(CANONICAL_SESSION_ID)

    const perRecord: unknown[][] = CANONICAL_SESSION_RECORDS.map(record => map(record))

    expect(perRecord[0]).toEqual([]) // seq1 user-prompt — echo, never emitted

    // seq2 thought (partial) → reasoning-start once + reasoning-delta
    expect(perRecord[1]).toEqual([
      { type: "reasoning-start", id: T1 },
      { type: "reasoning-delta", id: T1, delta: "Je dois d'abord regarder l'état du dépôt avant de proposer des changements." },
    ])
    // seq3 thought (final) → delta only (same reasoning run, no reopen)
    expect(perRecord[2]).toEqual([
      { type: "reasoning-delta", id: T1, delta: "Je dois d'abord regarder l'état du dépôt avant de proposer des changements.\n" },
    ])
    // seq4 text-delta (partial) closes reasoning, opens text
    expect(perRecord[3]).toEqual([
      { type: "reasoning-end", id: T1 },
      { type: "text-start", id: T1 },
      { type: "text-delta", id: T1, delta: "Bien sûr, je vais commencer" },
    ])
    // seq5 text-delta (final) → delta only (same text run)
    expect(perRecord[4]).toEqual([
      { type: "text-delta", id: T1, delta: "Bien sûr, je vais commencer par inspecter le dépôt.\n" },
    ])
    // seq6 tool-call → closes text, emits tool-input-available
    expect(perRecord[5]).toEqual([
      { type: "text-end", id: T1 },
      {
        type: "tool-input-available",
        toolCallId: "call_fixture_01",
        toolName: "bash",
        input: { command: "git status --short" },
      },
    ])
    // seq7 tool-call (isUpdate) → re-emits the same chunk with the new snapshot
    expect(perRecord[6]).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "call_fixture_01",
        toolName: "bash",
        input: { command: "git status --porcelain --branch", cwd: "/repo" },
      },
    ])
    // seq8 tool-result → tool-output-available with the RAW result (unwrapped)
    expect(perRecord[7]).toEqual([
      {
        type: "tool-output-available",
        toolCallId: "call_fixture_01",
        output: {
          stdout: " M packages/runtime/src/transcript-writer.ts\n",
          stderr: "",
          exitCode: 0,
        },
      },
    ])
    // seq9 tool-call-record → DELIBERATE skip (no chunk)
    expect(perRecord[8]).toEqual([])

    // seq10 permission-resolved → custom data part (CONDITION 4), NOT the ai
    // native tool-approval-request (that models a PENDING request).
    expect(perRecord[9]).toEqual([
      {
        type: "data-tool-call-approval",
        data: { toolCallId: "call_fixture_01", decision: "allow", optionId: "once" },
      },
    ])

    // seq11 tool-call → tool-input-available
    expect(perRecord[10]).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "call_fixture_02",
        toolName: "git",
        input: { subcommand: "commit", args: ["-m", "chore: tidy"], create_pr: true },
      },
    ])
    // seq12 tool-result → tool-output-available (RAW result, unwrapped)
    expect(perRecord[11]).toEqual([
      {
        type: "tool-output-available",
        toolCallId: "call_fixture_02",
        output: { output: { commit: "abc1234", prUrl: "https://github.com/agentproto/ts/pull/123" } },
      },
    ])
    // seq13 tool-call-record → DELIBERATE skip
    expect(perRecord[12]).toEqual([])

    // seq14 notice (unknown kind) → CONDITION 2: explicit error chunk + log
    expect(perRecord[13]).toEqual([
      { type: "error", errorText: "unhandled transcript record kind: notice" },
    ])
    expect(spy).toHaveBeenCalledTimes(1)
    const logged = String(spy.mock.calls[0]?.[0] ?? "")
    expect(logged).toContain("notice")
    expect(logged).toContain(CANONICAL_SESSION_ID)

    // seq15 turn-end → finish, closing any open segment; reason turn-complete → stop
    expect(perRecord[14]).toEqual([{ type: "finish", finishReason: "stop" }])

    // Flattened exact stream the client would receive.
    const flattened = perRecord.flat()
    expect(flattened).toEqual([
      { type: "reasoning-start", id: T1 },
      { type: "reasoning-delta", id: T1, delta: "Je dois d'abord regarder l'état du dépôt avant de proposer des changements." },
      { type: "reasoning-delta", id: T1, delta: "Je dois d'abord regarder l'état du dépôt avant de proposer des changements.\n" },
      { type: "reasoning-end", id: T1 },
      { type: "text-start", id: T1 },
      { type: "text-delta", id: T1, delta: "Bien sûr, je vais commencer" },
      { type: "text-delta", id: T1, delta: "Bien sûr, je vais commencer par inspecter le dépôt.\n" },
      { type: "text-end", id: T1 },
      { type: "tool-input-available", toolCallId: "call_fixture_01", toolName: "bash", input: { command: "git status --short" } },
      { type: "tool-input-available", toolCallId: "call_fixture_01", toolName: "bash", input: { command: "git status --porcelain --branch", cwd: "/repo" } },
      { type: "tool-output-available", toolCallId: "call_fixture_01", output: { stdout: " M packages/runtime/src/transcript-writer.ts\n", stderr: "", exitCode: 0 } },
      { type: "data-tool-call-approval", data: { toolCallId: "call_fixture_01", decision: "allow", optionId: "once" } },
      { type: "tool-input-available", toolCallId: "call_fixture_02", toolName: "git", input: { subcommand: "commit", args: ["-m", "chore: tidy"], create_pr: true } },
      { type: "tool-output-available", toolCallId: "call_fixture_02", output: { output: { commit: "abc1234", prUrl: "https://github.com/agentproto/ts/pull/123" } } },
      { type: "error", errorText: "unhandled transcript record kind: notice" },
      { type: "finish", finishReason: "stop" },
    ])
  })

  it("usage_update / usage_snapshot are a deliberate no-op — NOT the unknown-kind error path", () => {
    // Regression test: these are real, KNOWN daemon kinds (transcript-writer.ts
    // emits usage_update on essentially every turn) that are deliberately
    // excluded from CANONICAL_SESSION_RECORDS (see records.ts doc comment) —
    // not modeled in the shared fixture, so asserted directly here instead.
    // Before this fix, both kinds fell through to the `default` branch and
    // fired a spurious `error` chunk + console.error on every single turn
    // against a live daemon.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const map = createTranscriptToUiMapper(CANONICAL_SESSION_ID)

    expect(
      map({
        seq: 1,
        ts: "2026-08-17T00:00:00.000Z",
        kind: "usage_update",
        sessionId: CANONICAL_SESSION_ID,
        size: 200_000,
        used: 50_000,
      })
    ).toEqual([])

    expect(
      map({
        seq: 2,
        ts: "2026-08-17T00:00:01.000Z",
        kind: "usage_snapshot",
        sessionId: CANONICAL_SESSION_ID,
        model: "claude-sonnet-5",
        tokensIn: 1000,
        tokensOut: 200,
        source: "turn-end",
      })
    ).toEqual([])

    expect(spy).not.toHaveBeenCalled()
  })
})