/**
 * Unit tests for `corpus verify` — ports verify-entries.py's semantics
 * (coverage per facet, self-flag scan, --apply quarantine, --contaminated
 * siblings) against a small fixture workspace.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { runVerify } from "../verify.js"

let tmp: string
let logs: string[]
let errs: string[]

function entry(opts: {
  title: string
  tags: string[]
  sources: string[]
  body: string
  status?: string
}): string {
  const metadata = opts.status
    ? `metadata:\n  corpus:\n    status: ${opts.status}\n`
    : ""
  return [
    "---",
    `title: ${opts.title}`,
    `tags: [${opts.tags.join(", ")}]`,
    `sources: [${opts.sources.join(", ")}]`,
    metadata.trimEnd(),
    "---",
    "",
    opts.body,
    "",
  ]
    .filter((l) => l !== "")
    .join("\n")
}

async function writeEntry(relPath: string, content: string): Promise<void> {
  const target = path.join(tmp, "entries", relPath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content, "utf8")
}

async function seedWorkspace(): Promise<void> {
  await writeEntry(
    "patterns/clean.md",
    entry({
      title: "Clean entry about the landscape",
      tags: ["landscape"],
      sources: ["good-source"],
      body: "This is a totally fine entry about the orchestration landscape.",
    })
  )
  await writeEntry(
    "patterns/flagged.md",
    entry({
      title: "Landscape roundup",
      tags: ["landscape"],
      sources: ["bad-source"],
      body: "Distill note: no substantive content was found on this page.",
    })
  )
  await writeEntry(
    "patterns/sibling.md",
    entry({
      title: "Another landscape piece",
      tags: ["landscape"],
      sources: ["bad-source"],
      body: "This entry reads cleanly and has no self-flag markers.",
    })
  )
  await writeEntry(
    "patterns/thin.md",
    entry({
      title: "A daemon pattern",
      tags: ["daemons"],
      sources: ["other-source"],
      body: "Some daemon content.",
    })
  )
  await writeEntry(
    "patterns/inactive.md",
    entry({
      title: "Old landscape entry",
      tags: ["landscape"],
      sources: ["good-source"],
      body: "Superseded text, no longer active.",
      status: "superseded",
    })
  )
}

async function listAllFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const out: string[] = []
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...(await listAllFiles(full)))
      else out.push(path.relative(tmp, full))
    }
    return out
  } catch {
    return []
  }
}

beforeEach(async () => {
  tmp = path.join(tmpdir(), `corpus-verify-test-${Math.random().toString(36).slice(2)}`)
  await mkdir(tmp, { recursive: true })
  await seedWorkspace()
  logs = []
  errs = []
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    logs.push(chunk.toString())
    return true
  })
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errs.push(chunk.toString())
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(tmp, { recursive: true, force: true })
})

describe("runVerify", () => {
  it("requires --facets", async () => {
    const code = await runVerify([tmp])
    expect(code).toBe(2)
    expect(errs.join("")).toMatch(/--facets/)
  })

  it("fails when entries/ is missing", async () => {
    const empty = path.join(tmp, "empty-ws")
    await mkdir(empty, { recursive: true })
    const code = await runVerify([empty, "--facets", "landscape"])
    expect(code).toBe(1)
    expect(errs.join("")).toMatch(/no entries\//)
  })

  it("reports coverage per facet, excluding non-active entries", async () => {
    const code = await runVerify([tmp, "--facets", "landscape,daemons", "--thin", "2"])
    expect(code).toBe(0)
    const out = logs.join("")
    // landscape: clean + flagged + sibling = 3 active (inactive excluded)
    expect(out).toMatch(/landscape\s+3/)
    // daemons: 1 entry, below --thin 2 → THIN
    expect(out).toMatch(/daemons\s+1\s+THIN/)
  })

  it("flags self-flagged entries with the matched marker", async () => {
    const code = await runVerify([tmp, "--facets", "landscape,daemons", "--thin", "2"])
    expect(code).toBe(0)
    const out = logs.join("")
    expect(out).toMatch(/self-flagged entries \(1\)/)
    expect(out).toContain("patterns/flagged.md")
    expect(out).toContain("no substantive content")
    expect(out).not.toContain("patterns/clean.md  [")
  })

  it("does not flag the clean entry or the sibling without --contaminated", async () => {
    const code = await runVerify([tmp, "--facets", "landscape,daemons", "--thin", "2"])
    expect(code).toBe(0)
    const out = logs.join("")
    expect(out).not.toMatch(/contaminated siblings/)
  })

  it("--contaminated reports the sibling sharing the poisoned source", async () => {
    const code = await runVerify([
      tmp,
      "--facets",
      "landscape,daemons",
      "--thin",
      "2",
      "--contaminated",
    ])
    expect(code).toBe(0)
    const out = logs.join("")
    expect(out).toMatch(/contaminated siblings \(1\) from 1 poisoned source/)
    expect(out).toContain("patterns/sibling.md")
    expect(out).not.toContain("patterns/clean.md")
  })

  it("--apply moves exactly the flagged entry to demoted/, preserving subpath", async () => {
    const code = await runVerify([
      tmp,
      "--facets",
      "landscape,daemons",
      "--thin",
      "2",
      "--apply",
    ])
    expect(code).toBe(0)
    const files = await listAllFiles(tmp)
    expect(files).toContain(path.join("demoted", "patterns", "flagged.md"))
    expect(files).not.toContain(path.join("entries", "patterns", "flagged.md"))
    // Untouched siblings stay put.
    expect(files).toContain(path.join("entries", "patterns", "clean.md"))
    expect(files).toContain(path.join("entries", "patterns", "sibling.md"))
    expect(logs.join("")).toMatch(/moved 1 entries → demoted\//)
  })

  it("--apply --contaminated also demotes the sibling sharing the poisoned source", async () => {
    const code = await runVerify([
      tmp,
      "--facets",
      "landscape,daemons",
      "--thin",
      "2",
      "--apply",
      "--contaminated",
    ])
    expect(code).toBe(0)
    const files = await listAllFiles(tmp)
    expect(files).toContain(path.join("demoted", "patterns", "flagged.md"))
    expect(files).toContain(path.join("demoted", "patterns", "sibling.md"))
    expect(files).not.toContain(path.join("entries", "patterns", "flagged.md"))
    expect(files).not.toContain(path.join("entries", "patterns", "sibling.md"))
    // The clean entry (no shared source) is left alone.
    expect(files).toContain(path.join("entries", "patterns", "clean.md"))
    expect(logs.join("")).toMatch(/moved 2 entries → demoted\//)
  })

  it("without --apply, suggests re-running with --apply when entries are flagged", async () => {
    const code = await runVerify([tmp, "--facets", "landscape,daemons", "--thin", "2"])
    expect(code).toBe(0)
    expect(logs.join("")).toMatch(/re-run with --apply/)
  })

  it("reports thin facets with a loop-back hint", async () => {
    const code = await runVerify([tmp, "--facets", "landscape,daemons", "--thin", "2"])
    expect(code).toBe(0)
    expect(logs.join("")).toMatch(/thin facets → loop back to ② DISCOVER: daemons/)
  })
})
