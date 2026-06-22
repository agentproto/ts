import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSetupLedger } from "../ledger.js"
import type { SetupLedgerRecord } from "../types.js"

describe("makeSetupLedger", () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "adapter-kit-ledger-"))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const record = (slug: string): SetupLedgerRecord => ({
    slug,
    completedAt: "2026-06-22T00:00:00.000Z",
    steps: [{ id: "auth", completedAt: "2026-06-22T00:00:00.000Z" }],
  })

  it("exists false before write, true after", async () => {
    const ledger = makeSetupLedger({ home })
    expect(await ledger.exists("claude-code")).toBe(false)
    await ledger.write("claude-code", record("claude-code"))
    expect(await ledger.exists("claude-code")).toBe(true)
  })

  it("read returns null when absent, round-trips after write", async () => {
    const ledger = makeSetupLedger({ home })
    expect(await ledger.read("claude-code")).toBeNull()
    const rec = record("claude-code")
    await ledger.write("claude-code", rec)
    expect(await ledger.read("claude-code")).toEqual(rec)
  })

  it("writes the ledger file at ~/.agentproto/setup/<slug>.json with mode 0600", async () => {
    const ledger = makeSetupLedger({ home })
    await ledger.write("ngrok", record("ngrok"))
    const path = join(home, "setup", "ngrok.json")
    const st = await stat(path)
    expect(st.mode & 0o777).toBe(0o600)
  })
})
