/**
 * The disk path: load a WORKFLOW.md from the filesystem into a validated
 * handle. Covers the purely-declarative manifest, an entry-backed manifest
 * whose graph reconciles, and an entry whose graph disagrees (rejected).
 */

import { describe, it, expect } from "vitest"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import {
  loadWorkflowHandle,
  WorkflowLoadError,
  WorkflowReconcileError,
} from "../index.js"

const here = dirname(fileURLToPath(import.meta.url))
const fix = (p: string): string => join(here, "fixtures", p)

describe("loadWorkflowHandle", () => {
  it("loads a purely-declarative WORKFLOW.md (no entry)", async () => {
    const h = await loadWorkflowHandle(fix("declarative/WORKFLOW.md"))
    expect(h.id).toBe("double-add")
    expect(h.steps.map((s) => s.id)).toEqual(["d", "a"])
    expect(h.steps.map((s) => s.kind)).toEqual(["tool", "tool"])
  })

  it("loads an entry-backed WORKFLOW.md and reconciles the graph", async () => {
    const h = await loadWorkflowHandle(fix("with-entry/WORKFLOW.md"))
    expect(h.id).toBe("double-add")
    // the entry's handle is returned — it is the runtime source of truth
    expect(h.steps.map((s) => `${s.id}:${s.kind}`)).toEqual([
      "d:tool",
      "a:tool",
    ])
  })

  it("reconciles a real-shaped workflow graph (tool → map → transform → tool → tool)", async () => {
    const h = await loadWorkflowHandle(fix("leboncoin-shape/WORKFLOW.md"))
    expect(h.id).toBe("leboncoin-houses")
    expect(h.steps.map((s) => `${s.id}:${s.kind}`)).toEqual([
      "search:tool",
      "routes:map",
      "items:transform",
      "report:tool",
      "sent:tool",
    ])
  })

  it("rejects an entry whose graph disagrees with the manifest", async () => {
    await expect(loadWorkflowHandle(fix("mismatch/WORKFLOW.md"))).rejects.toThrow(
      WorkflowReconcileError,
    )
  })

  it("throws a clear error when the file does not exist", async () => {
    await expect(loadWorkflowHandle(fix("nope/WORKFLOW.md"))).rejects.toThrow(
      WorkflowLoadError,
    )
  })
})

describe("loadWorkflowHandle — subworkflow with: threading", () => {
  it("compiles with: parent input fields into step inputs", async () => {
    const h = await loadWorkflowHandle(fix("with-threading/WORKFLOW.md"))
    const sub = h.steps.find((s) => s.id === "sub") as unknown as Record<string, unknown>
    expect(sub.inputs).toMatchObject({
      topic: "$input.bookDir",
      audience: "$input.audience",
    })
    expect(sub.with).toBeUndefined()
  })

  it("compiles with: a prior step's output into step inputs", async () => {
    const h = await loadWorkflowHandle(fix("with-threading/WORKFLOW.md"))
    const sub = h.steps.find((s) => s.id === "sub") as unknown as Record<string, unknown>
    expect(sub.inputs).toMatchObject({ n: "$steps.d.n" })
  })

  it("passes with: literals through as literal values", async () => {
    const h = await loadWorkflowHandle(fix("with-threading/WORKFLOW.md"))
    const sub = h.steps.find((s) => s.id === "sub") as unknown as Record<string, unknown>
    expect(sub.inputs).toMatchObject({ limit: 3 })
  })

  it("leaves a subworkflow step without with: untouched (verbatim input)", async () => {
    const h = await loadWorkflowHandle(fix("with-threading/WORKFLOW.md"))
    const bare = h.steps.find((s) => s.id === "bare") as unknown as Record<string, unknown>
    expect(bare.inputs).toBeUndefined()
    expect(bare.with).toBeUndefined()
  })

  it("rejects a with: ref to an unknown step id, naming the step and key", async () => {
    await expect(loadWorkflowHandle(fix("with-bad-ref/WORKFLOW.md"))).rejects.toThrow(
      /subworkflow step 'sub' with\.topic references unknown step 'ghost'/,
    )
  })
})

describe("loadWorkflowHandle — harness.promptFile (AIP-15 P2)", () => {
  it("reads harness.promptFile relative to the WORKFLOW.md dir into the step's prompt + sha256", async () => {
    const h = await loadWorkflowHandle(fix("harness-promptfile/WORKFLOW.md"))
    const step = h.steps.find((s) => s.id === "s1") as unknown as Record<string, unknown>
    const raw = readFileSync(fix("harness-promptfile/prompt.txt"))
    expect(step.prompt).toBe(raw.toString("utf8").trim())
    const harness = step.harness as Record<string, unknown>
    expect(harness.promptSha).toBe(createHash("sha256").update(raw).digest("hex"))
  })

  it("throws a clear error naming the step when harness.promptFile does not exist", async () => {
    await expect(
      loadWorkflowHandle(fix("harness-promptfile-missing/WORKFLOW.md")),
    ).rejects.toThrow(/agent step 's1': cannot read harness\.promptFile/)
  })
})

describe("loadWorkflowHandle — kind: gate (AIP-15 P3)", () => {
  it("rejects a declarative gate step with no command", async () => {
    await expect(loadWorkflowHandle(fix("gate-no-command/WORKFLOW.md"))).rejects.toThrow(
      /gate step 'g' needs a non-empty 'command'/,
    )
  })
})
