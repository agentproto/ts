/**
 * compileWorkflowManifest — the connective step between an authored
 * `WORKFLOW.md` and a runnable workflow.
 *
 * AIP-15 ships every piece needed to run a declarative manifest except the
 * seam that joins them: `parseWorkflowManifest` (md + frontmatter → manifest)
 * and `workflowFromManifest` (manifest → `WorkflowHandle`) live in
 * `@agentproto/workflow`; `compileWorkflow` (handle → `RuntimeWorkflow`) lives
 * here. Without this chain an authored `WORKFLOW.md` parses and validates but
 * never reaches the executor. This joins the three so a manifest source string
 * compiles straight to a runnable workflow — no hand-built handle.
 *
 * Framework-pure: the caller owns reading the file off disk (this package does
 * no I/O), and passes the source string in. The tool registry + driver
 * candidates are injected via {@link CompileWorkflowOptions}, same as the
 * hand-built path.
 */

import {
  parseWorkflowManifest,
  workflowFromManifest,
} from "@agentproto/workflow/manifest"

import { compileWorkflow } from "./compile-workflow.js"
import type { CompileWorkflowOptions } from "./compile-workflow.js"
import type { RuntimeWorkflow } from "./types.js"

/**
 * Compile a `WORKFLOW.md` source string into a {@link RuntimeWorkflow} ready
 * for `runWorkflow`. Parses + validates the frontmatter against the AIP-15
 * schema, lifts it to a `WorkflowHandle`, then compiles its step graph against
 * the injected tool registry. Throws on invalid frontmatter (the parser's
 * diagnostic) or an unresolved tool / non-linear step (the compiler's).
 */
export function compileWorkflowManifest(
  source: string,
  opts: CompileWorkflowOptions,
): RuntimeWorkflow {
  const manifest = parseWorkflowManifest(source)
  const handle = workflowFromManifest(manifest)
  return compileWorkflow(handle, opts)
}
