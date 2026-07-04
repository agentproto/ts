/**
 * Back-compat re-export. The workflow def now lives in `@agentproto/worktree`
 * itself (so the runner bin doesn't need to depend on this example package)
 * — see that package's `src/workflow.ts`.
 */
export { worktreeAgentWorkflow, worktreeAgentInputSchema, type WorktreeAgentInput } from "@agentproto/worktree"
