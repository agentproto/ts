/**
 * Seq-aware daemon-events export: the `untilSeq` cut, `seq` stamping
 * (a batched assistant turn carries the seq of the record that STARTED it),
 * ordering across a restart-duplicated seq, and the `splitMessagesAtSeq`
 * head/tail cut a prepared checkpoint replays at swap time.
 *
 * Fixtures are real events.jsonl files in an OS tmp dir; `baseDir` is passed
 * to the exporter so the test never touches the real ~/.agentproto tree.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  exportDaemonEventsSession,
  splitMessagesAtSeq,
  type ExportedMessage,
} from "../transcript-export.js"

const SESSION_ID = "sess_seq_cut"
const TS = "2026-06-01T00:00:00.000Z"

describe("seq-aware daemon-events export", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "daemon-seq-"))
    mkdirSync(join(tmp, SESSION_ID), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  /** Write `lines` as events.jsonl, stamping `seq: i + 1` unless a line
   *  carries its own `seq` (a restart-duplicated seq, or none at all). */
  function writeEvents(lines: Array<Record<string, unknown>>): void {
    writeFileSync(
      join(tmp, SESSION_ID, "events.jsonl"),
      lines.map((l, i) => JSON.stringify({ seq: i + 1, ts: TS, ...l })).join("\n") + "\n",
    )
  }

  const exportAll = (): Promise<{ messages: ExportedMessage[] }> =>
    exportDaemonEventsSession(SESSION_ID, undefined, tmp)
  const exportUntil = (untilSeq: number): Promise<{ messages: ExportedMessage[] }> =>
    exportDaemonEventsSession(SESSION_ID, undefined, tmp, { untilSeq })

  // Two full turns: user → assistant+tool_call → tool_result → assistant.
  // Seqs 1..12; message boundaries fall on the records that flush a batch.
  const FLOW: Array<Record<string, unknown>> = [
    { kind: "user-prompt", text: "Do the thing" },
    { kind: "text-delta", text: "Looking around." },
    { kind: "tool-call", toolCallId: "t1", toolName: "bash", arguments: { command: "ls" } },
    { kind: "tool-result", toolCallId: "t1", result: "file1.txt\nfile2.txt" },
    { kind: "text-delta", text: "Two files." },
    { kind: "turn-end", reason: "completed" },
    { kind: "user-prompt", text: "Now fix it" },
    { kind: "text-delta", text: "Fixing." },
    { kind: "tool-call", toolCallId: "t2", toolName: "edit", arguments: { file: "a.ts" } },
    { kind: "tool-result", toolCallId: "t2", result: "ok" },
    { kind: "text-delta", text: "Done." },
    { kind: "turn-end", reason: "completed" },
  ]

  it("stamps each message with the seq of the record that started it (a batch: its first record)", async () => {
    writeEvents(FLOW)
    const { messages } = await exportAll()
    expect(messages.map(m => m.seq)).toEqual([1, 2, 4, 5, 7, 8, 10, 11])
    // The assistant batch opened by the text-delta at seq 2 carries seq 2 —
    // not the seq of the tool-call (3) or of the flush (4) inside it.
    expect(messages[1]).toMatchObject({ role: "assistant", text: "Looking around.", seq: 2 })
    expect(messages[1]?.toolCalls).toEqual([{ name: "bash", args: JSON.stringify({ command: "ls" }) }])
  })

  it("export with untilSeq X returns exactly the messages whose seq <= X", async () => {
    writeEvents(FLOW)
    const full = (await exportAll()).messages
    expect(full).toHaveLength(8)

    for (let x = 1; x <= FLOW.length + 1; x++) {
      const cut = (await exportUntil(x)).messages
      const expected = full.filter(m => m.seq !== undefined && m.seq <= x)
      // Exactly those messages — same identities, same order, nothing past
      // the cutoff and nothing dropped before it.
      expect(cut.map(m => m.seq), `untilSeq=${x}`).toEqual(expected.map(m => m.seq))
      expect(cut.every(m => m.seq === undefined || m.seq <= x), `untilSeq=${x}`).toBe(true)
    }

    // Boundary cutoffs (records that flush a batch) are byte-identical to
    // filtering the uncut export — not just the same seqs.
    expect((await exportUntil(6)).messages).toEqual(full.filter(m => (m.seq ?? 0) <= 6))
    expect((await exportUntil(10)).messages).toEqual(full.filter(m => (m.seq ?? 0) <= 10))
    expect((await exportUntil(FLOW.length)).messages).toEqual(full)
  })

  it("a record with no seq (a command session's kind-less line) survives the cut", async () => {
    // Exactly what recordCommand writes: a bare CommandLogEntry with NO seq,
    // then a normal seq-stamped record. The seq-less line can't be placed
    // past a seq cut, so it stays in the head.
    writeFileSync(
      join(tmp, SESSION_ID, "events.jsonl"),
      JSON.stringify({ ts: TS, command: "ls", args: [], cwd: "/repo", exitCode: 0 }) +
        "\n" +
        JSON.stringify({ seq: 1, ts: TS, kind: "user-prompt", text: "after" }) +
        "\n",
    )
    const { messages } = await exportUntil(1)
    expect(messages.map(m => m.role)).toEqual(["assistant", "tool", "user"])
    expect(messages[0]?.seq).toBeUndefined()
    expect(messages[1]?.seq).toBeUndefined()
    expect(messages[2]).toMatchObject({ role: "user", text: "after", seq: 1 })
    // …and splitMessagesAtSeq routes those seq-less messages to the head too.
    expect(splitMessagesAtSeq(messages, 0).atOrBefore).toHaveLength(2)
    expect(splitMessagesAtSeq(messages, 0).after).toHaveLength(1)
  })

  it("a restart-duplicated seq stays in file order (never re-sorted or de-duplicated)", async () => {
    // A daemon restart that resumed the counter wrong emits the same seqs
    // twice in one events.jsonl. The reader follows the file, not the seq.
    writeEvents([
      { kind: "user-prompt", text: "first turn" },
      { kind: "text-delta", text: "alpha" },
      { kind: "turn-end", reason: "completed" },
      { seq: 1, kind: "user-prompt", text: "after restart" },
      { seq: 2, kind: "text-delta", text: "beta" },
      { seq: 3, kind: "turn-end", reason: "completed" },
    ])
    const { messages } = await exportAll()
    expect(messages.map(m => [m.role, m.seq, m.text])).toEqual([
      ["user", 1, "first turn"],
      ["assistant", 2, "alpha"],
      ["user", 1, "after restart"],
      ["assistant", 2, "beta"],
    ])
  })
})

describe("splitMessagesAtSeq", () => {
  const messages: ExportedMessage[] = [
    { role: "user", text: "a", seq: 1 },
    { role: "assistant", text: "b", seq: 2 },
    { role: "tool", text: "c", seq: 3 },
    { role: "assistant", text: "d", seq: 4 },
    { role: "assistant", text: "no-seq" },
  ]

  it("splits head/tail at the cutoff and keeps both sides ordered", () => {
    const { atOrBefore, after } = splitMessagesAtSeq(messages, 3)
    expect(atOrBefore.map(m => m.text)).toEqual(["a", "b", "c", "no-seq"])
    expect(after.map(m => m.text)).toEqual(["d"])
  })

  it("puts seq-less messages in the head for any cutoff", () => {
    const { atOrBefore, after } = splitMessagesAtSeq(messages, 0)
    expect(atOrBefore.map(m => m.text)).toEqual(["no-seq"])
    expect(after.map(m => m.text)).toEqual(["a", "b", "c", "d"])
  })

  it("leaves everything in the head when the cutoff is past the last seq", () => {
    const { atOrBefore, after } = splitMessagesAtSeq(messages, 99)
    expect(atOrBefore).toEqual(messages)
    expect(after).toEqual([])
  })
})
