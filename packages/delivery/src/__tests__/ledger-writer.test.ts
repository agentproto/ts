import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DELIVERY_LEDGER_FILE, appendLedgerLine } from "../ledger-writer.js"
import type { LedgerLine } from "../ledger.js"

const line: LedgerLine = {
  ts: "2026-11-03T00:00:00.000Z",
  producer: "sentinel",
  subscriptionId: "sen_1",
  target: { kind: "session", id: "sess_1" },
  eventId: "evt_1",
  type: "fake.widget.created",
  subject: "fake:widget-1",
  eventTs: "2026-11-03T00:00:00.000Z",
  repeatKey: "fake:widget-1|",
  level: 2,
  cap: 3,
  rule: "default",
  applied: false,
  outcome: "delivered",
  messageId: "msg_1",
}

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe("appendLedgerLine", () => {
  it("appends exactly one JSON line and creates the parent directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-ledger-"))
    dirs.push(dir)
    const path = join(dir, "nested", DELIVERY_LEDGER_FILE)
    appendLedgerLine(path, line)
    const raw = readFileSync(path, "utf8")
    expect(raw.endsWith("\n")).toBe(true)
    const lines = raw.trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual(line)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("never throws on an unwritable path", () => {
    expect(() => appendLedgerLine("\u0000not-a-path", line)).not.toThrow()
  })
})

describe("root entry", () => {
  it("does not import node:fs; the writer lives on its own subpath", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8")
    expect(source).not.toContain("node:fs")
  })
})
