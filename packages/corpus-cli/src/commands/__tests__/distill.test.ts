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
import {
  BatchStore,
  type BatchDriver,
  type BatchHandle,
  type BatchRequest,
  type BatchResult,
} from "@agentproto/batch"
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

// ── batch engines ────────────────────────────────────────────────────────────
//
// `--engine anthropic-batch`/`openrouter-batch` go through @agentproto/batch's
// BatchDriver contract instead of a plain DistillPort. `deps.driver` forces a
// fake in-memory driver so these tests never need an API key or the network.

type FakeOutcome =
  | { readonly outcome: "succeeded"; readonly items: readonly DistilledItem[] }
  | { readonly outcome: "errored" | "expired" | "canceled" }

/** A BatchDriver whose `results()` are scripted per customId. `submit()` is
 *  tracked so tests can assert exactly what got batched together; `results()`
 *  looks requests up by handle id, seeded either by `submit()` itself or, for
 *  a `--batch-id` re-attach test, directly via `seed()`. */
function fakeBatchDriver(respond: (customId: string) => FakeOutcome): BatchDriver & {
  readonly submittedBatches: BatchRequest[][]
  seed(handleId: string, requests: readonly BatchRequest[]): void
} {
  const submittedBatches: BatchRequest[][] = []
  const byHandle = new Map<string, readonly BatchRequest[]>()
  let n = 0
  return {
    id: "fake-batch",
    submittedBatches,
    seed(handleId, requests) {
      byHandle.set(handleId, requests)
    },
    async submit(requests) {
      submittedBatches.push([...requests])
      n += 1
      const handle: BatchHandle = {
        id: `fake-${n}`,
        driver: "fake-batch",
        provider: { batchIds: [] },
        createdAt: new Date().toISOString(),
        requestCount: requests.length,
        models: Array.from(new Set(requests.map(r => r.body.model))),
      }
      byHandle.set(handle.id, requests)
      return handle
    },
    async status() {
      return {
        state: "ended" as const,
        counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      }
    },
    async *results(handle) {
      for (const request of byHandle.get(handle.id) ?? []) {
        const outcome = respond(request.customId)
        const result: BatchResult =
          outcome.outcome === "succeeded"
            ? {
                customId: request.customId,
                outcome: "succeeded",
                message: {
                  content: [{ type: "text", text: JSON.stringify(outcome.items) }],
                  model: request.body.model,
                  usage: { input_tokens: 10, output_tokens: 10 },
                },
              }
            : { customId: request.customId, outcome: outcome.outcome }
        yield result
      }
    },
    async cancel() {
      // not exercised by these tests
    },
  }
}

describe("runDistill — batch engines", () => {
  it("submits every pending source as ONE batch and writes entries with provenance", async () => {
    await writeSource("b1", "first batch source")
    await writeSource("b2", "second batch source")
    const driver = fakeBatchDriver(customId => ({
      outcome: "succeeded",
      items: [{ ...ITEM, title: `${customId} insight` }],
    }))

    const code = await runDistill([tmp, "--engine", "anthropic-batch"], { driver })
    expect(code).toBe(0)

    expect(driver.submittedBatches).toHaveLength(1)
    expect(driver.submittedBatches[0]!.map(r => r.customId).sort()).toEqual(["b1", "b2"])

    const files = await listEntryFiles()
    expect(files).toHaveLength(2)
    const sourcesSeen = new Set<string>()
    for (const f of files) {
      const fm = matter(await readFile(f, "utf8")).data as { sources?: string[] }
      for (const s of fm.sources ?? []) sourcesSeen.add(s)
    }
    expect(sourcesSeen).toEqual(new Set(["b1", "b2"]))
  })

  it("leaves an expired source undistilled — a follow-up run still picks it up", async () => {
    await writeSource("ok", "will succeed")
    await writeSource("exp", "will expire")
    const driver = fakeBatchDriver(customId =>
      customId === "exp"
        ? { outcome: "expired" }
        : { outcome: "succeeded", items: [{ ...ITEM, title: `${customId} insight` }] }
    )

    const code = await runDistill([tmp, "--engine", "anthropic-batch"], { driver })
    expect(code).toBe(0)
    expect(await listEntryFiles()).toHaveLength(1)

    // a follow-up run (any engine) still considers "exp" pending — no entry
    // was ever written for it, so the entry-scan resume set includes it again.
    const followUp = capturingDistiller()
    await runDistill([tmp], { distiller: followUp })
    expect(followUp.inputs.map(i => i.title)).toEqual(["exp source"])
  })

  it("--batch-id re-attaches to a batch submitted in a prior run, without resubmitting", async () => {
    await writeSource("r1", "resumed source")
    const request: BatchRequest = {
      customId: "r1",
      body: {
        model: "claude-sonnet-5",
        max_tokens: 10,
        messages: [{ role: "user", content: "placeholder prompt" }],
      },
    }
    const handle: BatchHandle = {
      id: "b_resume_test",
      driver: "anthropic-batch",
      provider: { batchIds: [] },
      createdAt: new Date().toISOString(),
      requestCount: 1,
      models: ["claude-sonnet-5"],
    }
    // Simulate a prior, interrupted run: the batch was already submitted and
    // persisted, but this process never got to poll/collect/write.
    const store = new BatchStore({ stateDir: path.join(tmp, ".distill") })
    await store.create(handle, [request])

    const driver = fakeBatchDriver(() => ({
      outcome: "succeeded",
      items: [{ ...ITEM, title: "resumed insight" }],
    }))
    driver.seed(handle.id, [request])

    const code = await runDistill([tmp, "--engine", "anthropic-batch", "--batch-id", handle.id], {
      driver,
    })

    expect(code).toBe(0)
    expect(driver.submittedBatches).toHaveLength(0) // never resubmitted
    expect(logs.join("")).toMatch(/re-attaching, skipping submit/)
    const files = await listEntryFiles()
    expect(files).toHaveLength(1)
    const fm = matter(await readFile(files[0]!, "utf8")).data as { sources?: string[] }
    expect(fm.sources).toEqual(["r1"])
  })
})
