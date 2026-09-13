/**
 * Unit tests for `buildResumeContextDigest` (Fix D) — the standalone digest
 * builder that reconstructs a bounded, best-effort context handoff from a
 * session's own `events.jsonl` (transcript-export.ts's daemon-events
 * exporter). Mirrors the "daemon-events exporter" describe block in
 * transcript-export.test.ts: fixtures live under a mocked homedir tmp tree.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as os from "node:os"
import { join } from "node:path"
import { buildResumeContextDigest } from "../resume-context-digest.js"

vi.mock("node:os", async importOriginal => {
  const orig = await importOriginal<typeof import("node:os")>()
  return { ...orig, homedir: vi.fn(() => orig.homedir()) }
})

const SESSION_ID = "sess_digest1"

describe("buildResumeContextDigest", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "resume-digest-"))
    vi.mocked(os.homedir).mockReturnValue(tmp)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  function writeEvents(lines: object[]): void {
    const dir = join(tmp, ".agentproto", "sessions", SESSION_ID)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "events.jsonl"),
      lines.map((l, i) => JSON.stringify({ seq: i + 1, ts: "2026-06-01T00:00:00.000Z", ...l })).join("\n") + "\n",
    )
  }

  it("returns { hasContent: false } when events.jsonl is absent", async () => {
    const result = await buildResumeContextDigest(SESSION_ID)
    expect(result.digest).toBeUndefined()
    expect(result.hasContent).toBe(false)
  })

  it("returns { hasContent: false } when events.jsonl exists but has no reconstructable messages", async () => {
    writeEvents([{ kind: "turn-end", reason: "completed" }])
    const result = await buildResumeContextDigest(SESSION_ID)
    expect(result.digest).toBeUndefined()
    expect(result.hasContent).toBe(false)
  })

  it("frames the digest as an explicit best-effort summary, not full context", async () => {
    writeEvents([
      { kind: "user-prompt", text: "Hello there." },
      { kind: "text-delta", text: "Hi! How can I help?" },
      { kind: "turn-end", reason: "completed" },
    ])
    const result = await buildResumeContextDigest(SESSION_ID)
    expect(result.digest).toBeDefined()
    expect(result.hasContent).toBe(true)
    expect(result.digest).toMatch(/^\[resumed session — prior conversation could not be natively restored/)
    expect(result.digest).toContain("best-effort summary")
    expect(result.digest).toContain("not full context")
    expect(result.digest).toContain("Hello there.")
    expect(result.digest).toContain("Hi! How can I help?")
  })

  it("hard-truncates a single oversized tool-result body instead of blowing the budget", async () => {
    const hugeResult = "x".repeat(50_000)
    writeEvents([
      { kind: "user-prompt", text: "Read the file." },
      { kind: "tool-call", toolCallId: "t1", toolName: "read_file", arguments: { path: "/big.txt" } },
      { kind: "tool-result", toolCallId: "t1", result: hugeResult, isError: false },
      { kind: "text-delta", text: "Done." },
      { kind: "turn-end", reason: "completed" },
    ])
    const result = await buildResumeContextDigest(SESSION_ID)
    expect(result.digest).toBeDefined()
    expect(result.hasContent).toBe(true)
    // The framed digest as a whole stays well under the raw 50k tool body —
    // both the per-tool-message cap and the overall budget backstop apply.
    expect((result.digest ?? "").length).toBeLessThan(10_000)
    expect(result.digest).not.toContain(hugeResult)
  })

  it("keeps the most recent turns and drops the oldest when the transcript exceeds the digest budget", async () => {
    const lines: object[] = []
    // Each turn's assistant text alone is ~1000 chars; 20 turns is well
    // over the ~7k digest budget, so only the tail should survive.
    for (let i = 0; i < 20; i++) {
      lines.push({ kind: "user-prompt", text: `turn-${i} user message marker-${i}` })
      lines.push({ kind: "text-delta", text: `turn-${i} assistant reply ${"y".repeat(1000)}` })
    }
    writeEvents(lines)
    const result = await buildResumeContextDigest(SESSION_ID)
    expect(result.digest).toBeDefined()
    expect(result.hasContent).toBe(true)
    const body = result.digest ?? ""
    expect(body.length).toBeLessThan(9000)
    // The very last turn must be present (most recent kept)...
    expect(body).toContain("marker-19")
    // ...while an early turn must have been dropped (oldest elided).
    expect(body).not.toContain("marker-0 ")
  })
})
