import { afterEach, describe, expect, it, vi } from "vitest"
import { join } from "node:path"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { loadAgent } from "@agentproto/agent"
import { createAgentOnScanner } from "../action-hooks/agent-on-scanner.js"

const dirs: string[] = []
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeAgent(workspace: string, dir: string, id: string, on?: string[]): string {
  const target = join(workspace, ".agents", dir)
  mkdirSync(target, { recursive: true })
  const lines = [
    "---",
    "schema: agent/v1",
    `id: "${id}"`,
    `description: Agent ${id} for testing`,
    "model: test-model",
    ...(on ?? []),
    "---",
    "",
    `You are agent ${id}.`,
  ]
  const path = join(target, "AGENT.md")
  writeFileSync(path, `${lines.join("\n")}\n`)
  return path
}

const ARCHIVE_ON = ["on:", "  agentproto:session-completed: session:archive"]

describe("createAgentOnScanner", () => {
  it("returns an empty result when the .agents directory is missing", async () => {
    const ws = tmp("agent-on-scanner-")
    const scanner = createAgentOnScanner({ workspace: ws, log: () => {} })
    const result = await scanner.rescan()
    expect(result).toEqual({ bindings: [], errors: [] })
  })

  it("skips a manifest without an on map", async () => {
    const ws = tmp("agent-on-scanner-")
    writeAgent(ws, "plain", "plain")
    const scanner = createAgentOnScanner({ workspace: ws, log: () => {} })
    const result = await scanner.rescan()
    expect(result.bindings).toEqual([])
    expect(result.errors).toEqual([])
  })

  it("numbers two entries of the same canonical event from zero", async () => {
    const ws = tmp("agent-on-scanner-")
    writeAgent(ws, "two", "two", [
      "on:",
      "  turn-end: session:archive",
      "  per-turn: session:archive",
    ])
    const scanner = createAgentOnScanner({ workspace: ws, log: () => {} })
    const result = await scanner.rescan()
    expect(result.bindings.map(binding => binding.bindingId)).toEqual([
      "two/on/turn-end/0",
      "two/on/turn-end/1",
    ])
  })

  it("leaves a turn-end session:clerk-pass entry to the clerk, so it is neither bound nor refused", async () => {
    const ws = tmp("agent-on-scanner-")
    writeAgent(ws, "clerked", "clerked", [
      "on:",
      "  turn-end:",
      "    - session:clerk-pass",
      "    - session:archive",
      "  agentproto:session-completed: session:archive",
    ])
    const scanner = createAgentOnScanner({ workspace: ws, log: () => {} })
    const result = await scanner.rescan()
    expect(result.bindings.map(binding => binding.bindingId)).toEqual([
      "clerked/on/turn-end/1",
      "clerked/on/agentproto:session-completed/0",
    ])
    expect(result.errors).toEqual([])
  })

  it("stores an @owner/name manifest id without the owner prefix", async () => {
    const ws = tmp("agent-on-scanner-")
    writeAgent(ws, "owned", "@owner/owned", ARCHIVE_ON)
    const scanner = createAgentOnScanner({ workspace: ws, log: () => {} })
    const result = await scanner.rescan()
    expect(result.bindings.map(binding => binding.bindingId)).toEqual([
      "owned/on/agentproto:session-completed/0",
    ])
    expect(result.bindings[0]?.source).toEqual({
      kind: "agent-on",
      agentId: "owned",
      event: "agentproto:session-completed",
      index: 0,
    })
  })

  it("reports one error for an invalid on map while a sibling still yields bindings", async () => {
    const ws = tmp("agent-on-scanner-")
    writeAgent(ws, "bad", "bad", ["on:", "  turn-end: {}"])
    writeAgent(ws, "good", "good", ARCHIVE_ON)
    const scanner = createAgentOnScanner({ workspace: ws, log: () => {} })
    const result = await scanner.rescan()
    expect(result.bindings.map(binding => binding.bindingId)).toEqual([
      "good/on/agentproto:session-completed/0",
    ])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.agentId).toBe("bad")
    expect(result.errors[0]?.error.length).toBeGreaterThan(0)
  })

  it("logs a manifest that fails to load once and skips it", async () => {
    const ws = tmp("agent-on-scanner-")
    const brokenDir = join(ws, ".agents", "broken")
    mkdirSync(brokenDir, { recursive: true })
    writeFileSync(join(brokenDir, "AGENT.md"), "# not a manifest\n")
    writeAgent(ws, "good", "good", ARCHIVE_ON)
    const log = vi.fn()
    const scanner = createAgentOnScanner({ workspace: ws, log })
    const result = await scanner.rescan()
    expect(result.bindings.map(binding => binding.bindingId)).toEqual([
      "good/on/agentproto:session-completed/0",
    ])
    expect(result.errors).toEqual([])
    expect(log).toHaveBeenCalledTimes(1)
    await scanner.rescan()
    expect(log).toHaveBeenCalledTimes(1)
  })

  it("keeps the first of two directories with the same agent id and reports the second", async () => {
    const ws = tmp("agent-on-scanner-")
    writeAgent(ws, "a-first", "dup", ["on:", "  agentproto:session-completed: session:archive"])
    writeAgent(ws, "b-second", "dup", [
      "on:",
      "  turn-end: session:other",
      "  per-turn: session:other",
    ])
    const scanner = createAgentOnScanner({ workspace: ws, log: () => {} })
    const result = await scanner.rescan()
    expect(result.bindings.map(binding => binding.bindingId)).toEqual([
      "dup/on/agentproto:session-completed/0",
    ])
    expect(result.errors).toEqual([{ agentId: "dup", error: "duplicate agent id" }])
  })

  it("replaces the cache on rescan, so removing the on map removes its bindings", async () => {
    const ws = tmp("agent-on-scanner-")
    const path = writeAgent(ws, "archiver", "archiver", ARCHIVE_ON)
    const scanner = createAgentOnScanner({ workspace: ws, log: () => {} })
    const first = await scanner.rescan()
    expect(first.bindings).toHaveLength(1)

    writeAgent(ws, "archiver", "archiver")
    const second = await scanner.rescan()
    expect(second.bindings).toEqual([])
    expect(scanner.current().bindings).toEqual([])
    expect(path).toContain("AGENT.md")
  })

  it("current() is empty before the first rescan", () => {
    const ws = tmp("agent-on-scanner-")
    const scanner = createAgentOnScanner({ workspace: ws, log: () => {} })
    expect(scanner.current()).toEqual({ bindings: [], errors: [] })
  })

  it("keeps the previous cache and logs when the agents directory cannot be listed", async () => {
    const ws = tmp("agent-on-scanner-")
    writeAgent(ws, "archiver", "archiver", ARCHIVE_ON)
    const log = vi.fn()
    const scanner = createAgentOnScanner({ workspace: ws, log })
    const first = await scanner.rescan()
    expect(first.bindings).toHaveLength(1)

    // `.agents` becomes a regular file: readdir fails with ENOTDIR, which is
    // not the "no directory" case and must not wipe the live bindings.
    rmSync(join(ws, ".agents"), { recursive: true, force: true })
    writeFileSync(join(ws, ".agents"), "not a directory")
    const second = await scanner.rescan()
    expect(second.bindings.map(binding => binding.bindingId)).toEqual([
      "archiver/on/agentproto:session-completed/0",
    ])
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]?.[0])).toContain("rescan failed")
  })

  it("drops the bindings of every manifest when all of them now fail to load", async () => {
    const ws = tmp("agent-on-scanner-")
    writeAgent(ws, "archiver", "archiver", ARCHIVE_ON)
    let fail = false
    const loader: typeof loadAgent = async (path, opts) => {
      if (fail) throw new Error("boom")
      return loadAgent(path, opts)
    }
    const scanner = createAgentOnScanner({ workspace: ws, loadAgent: loader, log: () => {} })
    expect((await scanner.rescan()).bindings).toHaveLength(1)

    fail = true
    expect((await scanner.rescan()).bindings).toEqual([])
  })
})
