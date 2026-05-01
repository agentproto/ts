/**
 * @agentproto/agencies-mastra — Mastra adapter for agentagencies/v1.
 *
 * Two roles:
 *   1. **Codegen** (./codegen) — turns a `PROCEDURE.md` into a Mastra `workflow.ts`
 *      file at build time. Apps run this codegen once per template + commit the
 *      generated workflow.ts; runtime then registers it with Mastra normally.
 *
 *   2. **Runtime** (this entry) — `createAgenciesBindings(config)` returns a
 *      bag of high-level orchestration helpers (engagement state machine,
 *      agreement issuer, invoice issuer) that compose the FS-only spec runtime
 *      with Mastra workflow primitives.
 *
 * Phase 1 ships scaffolding + the procedure-to-workflow codegen surface.
 * Phase 2 wires actual Mastra suspend/resume into the engagement state machine.
 */

export type { ProcedureToWorkflowOptions } from "./codegen.js"
export { procedureToWorkflow } from "./codegen.js"

/**
 * Bind agencies operations to a workspace + governance config.
 *
 * Phase 1 returns the input config + governance bindings; Phase 2 will add the
 * full engagement orchestrator (state machine over ENGAGEMENT.md status).
 */
export function createAgenciesBindings(_config: unknown): unknown {
  // TODO(phase-2): full engagement orchestrator with Mastra workflow integration.
  return {}
}
