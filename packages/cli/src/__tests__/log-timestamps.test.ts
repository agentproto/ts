import { describe, expect, it, vi } from "vitest"
import {
  installDaemonLogTimestamps,
  timestampedWrite,
} from "../commands/_log-timestamps.js"

const TS = "2026-10-18T19:41:00.000Z"

function fakeStream(): { stream: { write: (c: unknown) => boolean }; writes: unknown[] } {
  const writes: unknown[] = []
  const stream = { write: (c: unknown) => (writes.push(c), true) }
  return { stream, writes }
}

describe("timestampedWrite", () => {
  it("prefixes every line with the write moment, leaving the rest byte-identical", () => {
    const { stream, writes } = fakeStream()
    timestampedWrite(stream, { now: () => new Date(TS) })
    stream.write("hello\nworld\n")
    expect(writes).toEqual([`${TS} hello\n${TS} world\n`])
  })

  it("a chunk ending in a partial line is not prefixed; the continuation chunk stays on the same line", () => {
    const { stream, writes } = fakeStream()
    timestampedWrite(stream, { now: () => new Date(TS) })
    stream.write("part")
    stream.write("icu")
    stream.write("lar\nnext")
    expect(writes).toEqual([`${TS} part`, "icu", "lar\n" + `${TS} next`])
  })

  it("only string writes get a prefix; buffers pass through untouched", () => {
    const { stream, writes } = fakeStream()
    timestampedWrite(stream, { now: () => new Date(TS) })
    const bytes = new TextEncoder().encode("raw")
    stream.write(bytes)
    expect(writes).toEqual([bytes])
  })

  it("the unwinder restores the original write", () => {
    const stream = { write: (c: string) => !!c }
    const original = stream.write
    const undo = timestampedWrite(stream)
    undo()
    expect(stream.write).toBe(original)
  })
})

describe("installDaemonLogTimestamps", () => {
  function fakeProcess(stdoutIsTTY: boolean, stderrIsTTY: boolean) {
    const out = fakeStream()
    const err = fakeStream()
    const proc = {
      stdout: { isTTY: stdoutIsTTY, write: out.stream.write } as unknown as NodeJS.WriteStream,
      stderr: { isTTY: stderrIsTTY, write: err.stream.write } as unknown as NodeJS.WriteStream,
    } as unknown as typeof process
    return { proc, out, err }
  }

  it("wraps redirected streams and never a TTY", () => {
    const redirected = fakeProcess(false, false)
    const ttys = fakeProcess(true, true)
    const undid = installDaemonLogTimestamps(redirected.proc, { now: () => new Date(TS) })
    installDaemonLogTimestamps(ttys.proc, { now: () => new Date(TS) })

    redirected.proc.stdout.write("a\n")
    redirected.proc.stderr.write("b\n")
    ttys.proc.stdout.write("c\n")
    ttys.proc.stderr.write("d\n")

    expect(redirected.out.writes).toEqual([`${TS} a\n`])
    expect(redirected.err.writes).toEqual([`${TS} b\n`])
    expect(ttys.out.writes).toEqual(["c\n"])
    expect(ttys.err.writes).toEqual(["d\n"])

    for (const undo of undid) undo()
  })

  it("is idempotent: a second install does not double-prefix", () => {
    const { proc, out } = fakeProcess(false, false)
    installDaemonLogTimestamps(proc, { now: () => new Date(TS) })
    installDaemonLogTimestamps(proc, { now: () => new Date(TS) })
    proc.stdout.write("a\n")
    expect(out.writes).toEqual([`${TS} a\n`])
  })

  it("the unwinders revert to the pre-install writes", () => {
    const { proc, out } = fakeProcess(false, false)
    const undid = installDaemonLogTimestamps(proc, { now: () => new Date(TS) })
    proc.stdout.write("a\n")
    for (const undo of undid) undo()
    proc.stdout.write("b\n")
    expect(out.writes).toEqual([`${TS} a\n`, "b\n"])
  })
})
