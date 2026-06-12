/**
 * Reconcile a WORKFLOW.md manifest against the handle its `entry` module
 * exports. An entry-backed workflow declares its step graph twice — once as
 * governance-facing manifest data, once as the runnable handle — so the two
 * MUST agree, or the manifest is lying about what actually runs. This checks
 * the workflow id and the top-level step (id, kind) sequence; nested step
 * lists (map / loop / parallel bodies) are the entry's concern.
 */

import type { WorkflowManifest } from "@agentproto/workflow/manifest"
import type { WorkflowHandle } from "@agentproto/workflow"

export class WorkflowReconcileError extends Error {
  constructor(message: string) {
    super(`reconcileEntry: ${message}`)
    this.name = "WorkflowReconcileError"
  }
}

interface IdKind {
  readonly id: string
  readonly kind: string
}

const idKind = (steps: readonly IdKind[]): IdKind[] =>
  steps.map((s) => ({ id: s.id, kind: s.kind }))

const summary = (steps: readonly IdKind[]): string =>
  steps.map((s) => `${s.id}:${s.kind}`).join(" → ") || "(none)"

export function reconcileEntry(
  manifest: WorkflowManifest,
  handle: WorkflowHandle,
): void {
  const fm = manifest.frontmatter
  if (fm.id !== handle.id) {
    throw new WorkflowReconcileError(
      `manifest id '${fm.id}' ≠ entry id '${handle.id}'.`,
    )
  }
  const declared = idKind(fm.steps as readonly IdKind[])
  const actual = idKind(handle.steps as readonly IdKind[])
  if (declared.length !== actual.length) {
    throw new WorkflowReconcileError(
      `step count differs — manifest declares ${declared.length} [${summary(declared)}], ` +
        `entry has ${actual.length} [${summary(actual)}].`,
    )
  }
  for (let i = 0; i < declared.length; i++) {
    const d = declared[i]!
    const a = actual[i]!
    if (d.id !== a.id || d.kind !== a.kind) {
      throw new WorkflowReconcileError(
        `step ${i} differs — manifest '${d.id}:${d.kind}' ≠ entry '${a.id}:${a.kind}'. ` +
          `manifest [${summary(declared)}] vs entry [${summary(actual)}].`,
      )
    }
  }
}
