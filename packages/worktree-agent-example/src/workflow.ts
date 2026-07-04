import { z } from "zod"
import type { RuntimeWorkflow } from "@agentproto/workflow-runtime"
import {
  provisionWorktreeTool,
  cleanupWorktreeTool,
  runGateTool,
  worktreeProvider,
} from "@agentproto/worktree"

/**
 * Input to the worktree-agent workflow: launch a coding agent inside a
 * fresh git worktree, gate its work, and — on approval — clean up.
 */
export const worktreeAgentInputSchema = z.object({
  repoRoot: z.string().describe("Absolute path to the git repository root."),
  slug: z.string().describe("Worktree/branch identifier, e.g. 'fix-flaky-test'."),
  base: z.string().optional().describe("Ref to cut the worktree branch from. Default 'origin/main'."),
  depsCmd: z.string().optional().describe("Command to install deps inside the worktree, e.g. 'pnpm install --prefer-offline'."),
  copyGlobs: z.array(z.string()).optional().describe("Gitignored files to copy into the worktree, e.g. secrets."),
  task: z.string().describe("The prompt sent to the coding agent."),
  adapter: z.string().optional().describe("Agent adapter slug. Default 'claude-code'."),
  gateCmd: z.string().describe("Command run inside the worktree to check the agent's work, e.g. 'pnpm test'."),
  deleteBranch: z.boolean().optional().describe("Delete the worktree's branch on cleanup. Default true."),
})

export type WorktreeAgentInput = z.infer<typeof worktreeAgentInputSchema>

const candidates = [worktreeProvider]

function input(b: { input: unknown }): WorktreeAgentInput {
  return b.input as WorktreeAgentInput
}

/**
 * provision (tool) → code (AgentStep, cwd bound to provision's output) →
 * gate (tool) → on pass: approval → cleanup (tool); on fail: leave the
 * worktree in place for inspection.
 */
export const worktreeAgentWorkflow: RuntimeWorkflow = {
  id: "worktree-agent",
  description:
    "Launch a coding agent inside a fresh git worktree, gate its work with a " +
    "check command, get a human ack, then clean up. On gate failure the " +
    "worktree is left in place for inspection instead of being cleaned up.",
  steps: [
    {
      kind: "tool",
      id: "provision",
      tool: provisionWorktreeTool,
      candidates,
      input: (b) => {
        const i = input(b)
        return {
          repoRoot: i.repoRoot,
          slug: i.slug,
          base: i.base,
          depsCmd: i.depsCmd,
          copyGlobs: i.copyGlobs,
        }
      },
    },
    {
      kind: "agent",
      id: "code",
      adapter: (b) => input(b).adapter ?? "claude-code",
      cwd: (b) => (b.steps.provision as { cwd: string }).cwd,
      prompt: (b) => input(b).task,
    },
    {
      kind: "tool",
      id: "gate",
      tool: runGateTool,
      candidates,
      input: (b) => ({
        cwd: (b.steps.provision as { cwd: string }).cwd,
        cmd: input(b).gateCmd,
      }),
    },
    {
      kind: "branch",
      id: "route",
      cond: (b) => (b.steps.gate as { passed: boolean }).passed,
      then: [
        {
          kind: "approval",
          id: "approval",
          prompt: () => "Gate passed. Approve worktree cleanup?",
          onApprove: [
            {
              kind: "tool",
              id: "cleanup",
              tool: cleanupWorktreeTool,
              candidates,
              input: (b) => ({
                repoRoot: input(b).repoRoot,
                cwd: (b.steps.provision as { cwd: string }).cwd,
                branch: (b.steps.provision as { branch: string }).branch,
                deleteBranch: input(b).deleteBranch ?? true,
              }),
            },
          ],
          onReject: [
            {
              kind: "transform",
              id: "held",
              compute: () => ({ removed: false, reason: "cleanup_rejected" as const }),
            },
          ],
        },
      ],
      otherwise: [
        {
          kind: "transform",
          id: "gate-failed",
          compute: () => ({ removed: false, reason: "gate_failed" as const }),
        },
      ],
    },
  ],
  output: (b) => ({
    cwd: (b.steps.provision as { cwd: string }).cwd,
    branch: (b.steps.provision as { branch: string }).branch,
    gate: b.steps.gate,
    cleanup: b.steps.cleanup ?? b.steps.held ?? b.steps["gate-failed"],
  }),
}
