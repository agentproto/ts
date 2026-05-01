/**
 * PROCEDURE.md → Mastra `workflow.ts` codegen.
 *
 * Reads a procedure doctype + emits a TypeScript file that instantiates a
 * Mastra workflow with one step per procedure step. Branching steps emit
 * conditional resume logic; signature gates suspend via the governance Mastra adapter.
 *
 * Phase 1 scaffolding: outputs a skeleton workflow.ts with TODO markers where
 * signature gates need to wire to @agentproto/governance-mastra primitives.
 */

import type { ProcedureFrontmatter } from "@agentproto/agencies/doctypes"

export interface ProcedureToWorkflowOptions {
  /** Workflow id used by Mastra (defaults to procedure slug). */
  workflowId?: string
  /** Module specifier for tools used in the workflow (defaults to app's own tools file). */
  toolsModuleSpecifier?: string
  /** Module specifier for the agencies bindings (defaults to "@agentproto/agencies-mastra"). */
  bindingsModuleSpecifier?: string
}

/**
 * Generate a Mastra `workflow.ts` source string from a parsed PROCEDURE.md
 * frontmatter.
 *
 * Phase 1 emits a skeleton with one step stub per procedure step + comments
 * pointing at the canvakit/agency.* templates and the governance suspend hook.
 * Apps customize the generated file then commit it.
 */
export function procedureToWorkflow(
  procedure: ProcedureFrontmatter,
  options: ProcedureToWorkflowOptions = {}
): string {
  const id = options.workflowId ?? procedure.slug
  const tools = options.toolsModuleSpecifier ?? "../tools/index.js"
  const bindings = options.bindingsModuleSpecifier ?? "@agentproto/agencies-mastra"

  const stepBlocks = procedure.steps
    .map((step, index) => {
      const next = procedure.steps[index + 1]?.id ?? "<final>"
      return `// Step: ${step.id}
// description: ${step.description ?? "(no description)"}
// requiredSkill: ${step.requiredSkill ?? "(none)"}
// expected output: ${step.output ?? "(none)"}
//
// TODO(phase-2): emit a Mastra step (tools[...], inputSchema, outputSchema, execute).
// If this step has \`branch\`, emit conditional resume to one of the branch.action targets.
// If this step requires signatures, suspend via @agentproto/governance-mastra
// shouldSuspendForSignatures + resume on signArtifact completion.
// Next step: ${next}
`
    })
    .join("\n")

  return `/**
 * AUTO-GENERATED from PROCEDURE.md slug=${procedure.slug} (agentagencies/v1).
 * DO NOT EDIT BY HAND — re-run \`@agentproto/agencies-mastra\` codegen if the procedure changes.
 *
 * Procedure name: ${procedure.name}
 * Procedure description: ${procedure.description ?? "(no description)"}
 * Triggers: ${procedure.triggers.map(t => t.kind).join(", ") || "(none)"}
 * Required skills: ${procedure.requiredSkills.join(", ") || "(none)"}
 * Autonomy policy: ${procedure.autonomyPolicy ?? "(none)"}
 */

import { createWorkflow } from "@mastra/core/workflows" // peer dep
import { createGovernanceBindings } from "${bindings}"
import * as agencyTools from "${tools}" // app-provided tool registry

export const ${id.replace(/-/g, "_")}_workflow = createWorkflow({
  id: ${JSON.stringify(id)},
  steps: {
    // ─── steps ──────────────────────────────────────────────────────────
${stepBlocks}
  },
})
`
}
