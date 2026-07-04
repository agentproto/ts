/**
 * @agentproto/worktree — provision / gate / cleanup a git worktree.
 *
 * The AIP-14 contracts a worktree-agent WORKFLOW (@see examples/worktree-agent)
 * binds an AgentStep's `cwd` to: `worktree.provision` creates the worktree
 * (+ optional deps install + gitignored-secret copy), `worktree.run-gate` runs
 * a check command inside it, `worktree.cleanup` removes it.
 */

export { provisionWorktreeTool, cleanupWorktreeTool, runGateTool } from "./tools/index.js"
export { worktreeProvider } from "./provider/index.js"
export { execArgv, execShell, execGit, type ExecResult } from "./exec.js"
export { expandGlob, globToRegExp } from "./glob.js"
export { worktreeAgentWorkflow, worktreeAgentInputSchema, type WorktreeAgentInput } from "./workflow.js"
