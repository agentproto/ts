/**
 * AIP-15 WORKFLOW.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineWorkflow` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-15/draft/WORKFLOW.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { workflowFrontmatterSchema, type WorkflowFrontmatter } from "../schema.js"
import { defineWorkflow } from "../define-workflow.js"
import type { WorkflowDefinition, WorkflowHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/workflow/manifest" or directly from "@@agentproto/workflow/schema".
export { workflowFrontmatterSchema, type WorkflowFrontmatter }

export interface WorkflowManifest {
  frontmatter: WorkflowFrontmatter
  body: string
}

export function parseWorkflowManifest(source: string): WorkflowManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseWorkflowManifest: missing or empty frontmatter")
  }
  const result = workflowFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseWorkflowManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function workflowFromManifest(manifest: WorkflowManifest): WorkflowHandle {
  // The zod-validated frontmatter is structurally compatible with
  // WorkflowDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineWorkflow(manifest.frontmatter as unknown as WorkflowDefinition)
}
