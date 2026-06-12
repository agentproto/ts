/**
 * The disk path: load a WORKFLOW.md from the filesystem into a validated
 * handle. Covers the purely-declarative manifest, an entry-backed manifest
 * whose graph reconciles, and an entry whose graph disagrees (rejected).
 */

import { describe, it, expect } from "vitest"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
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
