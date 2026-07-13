import { z } from "zod"
import { defineTool } from "@agentproto/tool"

/** AIP-14 contract: remove a git worktree, optionally deleting its branch. */
export const cleanupWorktreeTool = defineTool({
  id: "worktree.cleanup",
  description:
    "Remove a git worktree created by 'worktree.provision' (force-removed, " +
    "since installed deps / copied secrets / agent output leave it with " +
    "untracked files). If `deleteBranch` is true and `branch` is given, also " +
    "force-delete that branch.",
  version: "0.1.0",
  inputSchema: z.object({
    repoRoot: z.string().describe("Absolute path to the git repository root."),
    cwd: z.string().describe("Absolute path to the worktree to remove."),
    branch: z.string().optional().describe("The worktree's branch, for deleteBranch."),
    deleteBranch: z.boolean().optional().describe("Also force-delete `branch` after removing the worktree."),
    base: z.string().optional().describe("Ref whose committed agentproto.json supplies teardown hooks. Default 'origin/main'."),
    runTeardown: z.boolean().optional().describe("Run the `worktree.teardown` hooks before removal. Default true; teardown failures are logged, never blocking."),
  }),
  outputSchema: z.object({
    removed: z.literal(true),
  }),
  mutates: ["fs:write"],
  approval: "auto",
  riskLevel: 1,
})
