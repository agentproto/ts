/**
 * Unit tests for `corpus distill --lens`: flag parsing, lens resolution wiring,
 * instruction/aspect threading through the runner, the `(source, lens)` resume
 * ledger, and back-compat of the lens-less generic pass. The distiller is a
 * fake injected via `runDistill(args, { distiller })`, so no LLM is called.
 */

import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import matter from "gray-matter"
import { DistillIndex, type DistillInput, type DistilledItem, type DistillPort } from "@agentproto/corpus"
import { NodeFsAdapter } from "../../ports/local-fs.adapter.js"
import { parse, runDistill } from "../distill.js"

let tmp: string
let logs: string[]
let errs: string[]

const ITEM: DistilledItem = {
  kind: "pattern",
  title: "Delay the thesis until a concrete image lands",
  body: "Open on a scene, not the claim. Beats the AI default of front-loading the thesis.",
  tags: ["hook"],
}

/** A DistillPort that records the inputs it saw and returns fixed items. */
function capturingDistiller(items: DistilledItem[] = [ITEM]): DistillPort & {
  inputs: DistillInput[]
} {
  const inputs: DistillInput[] = []
  return {
    inputs,
    distill: vi.fn(async (input: DistillInput) => {
      inputs.push(input)
      return items
    }),
  }
}

async function writeSource(id: string, body: string): Promise<void> {
  const dir = path.join(tmp, "sources")
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, `${id}.md`),
    ["---", `id: ${id}`, `title: ${id} source`, "---", "", body, ""].join("\n"),
    "utf8"
  )
}

async function writeWorkspaceLens(id: string, prompt: string, kinds?: string): Promise<void> {
  const dir = path.join(tmp, "lenses")
  await mkdir(dir, { recursive: true })
  const fm = ["---", `label: ${id}`, ...(kinds ? [`kinds: ${kinds}`] : []), "---", "", prompt, ""]
  await writeFile(path.join(dir, `${id}.md`), fm.join("\n"), "utf8")
}

async function listEntryFiles(): Promise<string[]> {
  const dir = path.join(tmp, "entries")
  try {
    const ents = await readdir(dir, { recursive: true, withFileTypes: true })
    return ents
      .filter(e => e.isFile() && e.name.endsWith(".md"))
      .map(e => path.join(e.parentPath, e.name))
  } catch {
    return []
  }
}

async function readAllEntryTags(): Promise<string[]> {
  const tags: string[] = []
  for (const f of await listEntryFiles()) {
    const fm = matter(await readFile(f, "utf8")).data as { tags?: string[] }
    if (fm.tags) tags.push(...fm.tags)
  }
  return tags
}

function loadLedger(): DistillIndex {
  return new DistillIndex({ fs: new NodeFsAdapter({ root: tmp }) })
}

beforeEach(async () => {
  tmp = path.join(tmpdir(), `corpus-distill-test-${Math.random().toString(36).slice(2)}`)
  await mkdir(tmp, { recursive: true })
  logs = []
  errs = []
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
    logs.push(chunk.toString())
    return true
  })
  vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
    errs.push(chunk.toString())
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(tmp, { recursive: true, force: true })
})

describe("parse", () => {
  it("parses --lens and --lens-file alongside the workspace arg", () => {
    expect(parse(["ws", "--lens", "craft"]).lens).toBe("craft")
    expect(parse(["ws", "--lens", "craft"]).workspace).toBe("ws")
    expect(parse(["--lens-file", "/p/x.md", "ws"]).lensFile).toBe("/p/x.md")
    expect(parse(["ws"]).lens).toBeUndefined()
    expect(parse(["ws"]).lensFile).toBeUndefined()
  })
})

describe("runDistill — lens validation", () => {
  it("rejects --lens together with --lens-file", async () => {
    const code = await runDistill([tmp, "--lens", "craft", "--lens-file", "x.md"], {
      distiller: capturingDistiller(),
    })
    expect(code).toBe(2)
    expect(errs.join("")).toMatch(/mutually exclusive/)
  })

  it("fails with a listing for an unknown lens id", async () => {
    const code = await runDistill([tmp, "--lens", "does-not-exist"], {
      distiller: capturingDistiller(),
    })
    expect(code).toBe(2)
    expect(errs.join("")).toMatch(/unknown lens/)
    expect(errs.join("")).toMatch(/craft/)
  })
})

describe("runDistill --lens craft", () => {
  it("threads the craft prompt + kinds to the distiller and stamps aspect:craft", async () => {
    await writeSource("s1", "An essay whose craft we want to extract.")
    const distiller = capturingDistiller()

    const code = await runDistill([tmp, "--lens", "craft"], { distiller })
    expect(code).toBe(0)

    // the lens prompt + kinds reached the distiller
    expect(distiller.inputs).toHaveLength(1)
    expect(distiller.inputs[0]!.instruction).toMatch(/WRITING-CRAFT MOVES/)
    expect(distiller.inputs[0]!.kinds).toEqual(["pattern", "principle", "critique", "example"])

    // every written entry carries the aspect facet tag (colon preserved)
    expect(await readAllEntryTags()).toContain("aspect:craft")

    // ledger row keyed by (source, craft)
    const row = await loadLedger().get("s1", "craft")
    expect(row).not.toBeNull()
    expect(row!.entryCount).toBe(1)
    expect(row!.contentHash).toMatch(/^sha256:/)
  })

  it("resolves a built-in craft even with no workspace declaration", async () => {
    await writeSource("s1", "body")
    const code = await runDistill([tmp, "--lens", "craft"], { distiller: capturingDistiller() })
    expect(code).toBe(0)
    expect(logs.join("")).toMatch(/lens:\s+craft \(aspect:craft\)/)
  })
})

describe("runDistill — ledger keyed by (source, lens)", () => {
  it("two lenses over one source do NOT skip each other", async () => {
    await writeSource("s1", "one source, read under two lenses")
    await writeWorkspaceLens("depth", "Extract how the piece manufactures depth.", "[pattern, principle]")

    const craft = capturingDistiller()
    const depth = capturingDistiller([{ ...ITEM, title: "Layer specifics before the abstraction" }])

    const c1 = await runDistill([tmp, "--lens", "craft"], { distiller: craft })
    const c2 = await runDistill([tmp, "--lens", "depth"], { distiller: depth })
    expect(c1).toBe(0)
    expect(c2).toBe(0)

    // both lenses actually distilled the same source — no cross-lens short-circuit
    expect(craft.distill).toHaveBeenCalledTimes(1)
    expect(depth.distill).toHaveBeenCalledTimes(1)

    const index = loadLedger()
    const rows = await index.load()
    expect(rows).toHaveLength(2)
    expect(await index.get("s1", "craft")).not.toBeNull()
    expect(await index.get("s1", "depth")).not.toBeNull()
    // the generic lens-less key must NOT match a lensed row
    expect(await index.get("s1")).toBeNull()

    // the depth lens's constrained kinds reached the distiller
    expect(depth.inputs[0]!.kinds).toEqual(["pattern", "principle"])
  })

  it("re-running the SAME lens on an unchanged source skips it (no distiller call)", async () => {
    await writeSource("s1", "unchanged body")

    const first = capturingDistiller()
    await runDistill([tmp, "--lens", "craft"], { distiller: first })
    expect(first.distill).toHaveBeenCalledTimes(1)

    const second = capturingDistiller()
    const code = await runDistill([tmp, "--lens", "craft"], { distiller: second })
    expect(code).toBe(0)
    expect(second.distill).not.toHaveBeenCalled()
    expect(logs.join("")).toMatch(/nothing to do/)
  })
})

describe("runDistill — back-compat (no --lens)", () => {
  it("runs the generic pass: no instruction, no aspect tag, no ledger file", async () => {
    await writeSource("s1", "generic body")
    const distiller = capturingDistiller()

    const code = await runDistill([tmp], { distiller })
    expect(code).toBe(0)

    expect(distiller.inputs).toHaveLength(1)
    expect(distiller.inputs[0]!.instruction).toBeUndefined()
    expect(distiller.inputs[0]!.kinds).toBeUndefined()

    // no aspect facet stamped on generic entries
    expect(await readAllEntryTags()).not.toContain("aspect:craft")

    // the lens ledger sidecar is never written on the lens-less path
    expect(existsSync(path.join(tmp, "_distill-index.yaml"))).toBe(false)
  })

  it("resumes by scanning existing entries (a distilled source is skipped)", async () => {
    await writeSource("s1", "resume body")

    const first = capturingDistiller()
    await runDistill([tmp], { distiller: first })
    expect(first.distill).toHaveBeenCalledTimes(1)

    const second = capturingDistiller()
    await runDistill([tmp], { distiller: second })
    expect(second.distill).not.toHaveBeenCalled()
  })
})
