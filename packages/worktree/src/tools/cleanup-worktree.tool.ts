import { z } from "zod"
import { defineTool } from "@agentproto/tool"

/**
 * AIP-14 contract: remove a git worktree, optionally deleting its branch.
 *
 * Guarded by default (PLAN.md §5.2 layer 3): with neither discard flag set,
 * this runs a plain `git worktree remove` — git itself is the final arbiter
 * and refuses on modified or unignored-untracked files, tolerating gitignored
 * trees like `node_modules/`. `discardUntracked` / `discardModified` each
 * authorize exactly one class of destruction git otherwise refuses; only
 * when the flags cover everything actually dirty does `--force` get passed
 * through. This replaces an unconditional `--force` that used to destroy
 * real edits indiscriminately (the incident this contract change exists to
 * prevent) — hence `riskLevel: 2`, up from the old unconditional-force `1`.
 */
export const cleanupWorktreeTool = defineTool({
  id: "worktree.cleanup",
  description:
    "Remove a git worktree created by 'worktree.provision'. Refuses if the " +
    "worktree has modified tracked files or unignored untracked files, " +
    "unless the matching `discardModified` / `discardUntracked` flag is " +
    "set — a clean or gitignore-only tree (e.g. installed deps) always " +
    "removes with no flags. If `deleteBranch` is true and `branch` is " +
    "given, also force-delete that branch (only ever called for merged " +
    "branches by this package's own callers).",
  version: "0.2.0",
  inputSchema: z.object({
    repoRoot: z.string().describe("Absolute path to the git repository root."),
    cwd: z.string().describe("Absolute path to the worktree to remove."),
    branch: z.string().optional().describe("The worktree's branch, for deleteBranch."),
    deleteBranch: z.boolean().optional().describe("Also force-delete `branch` after removing the worktree."),
    base: z.string().optional().describe("Ref whose committed agentproto.json supplies teardown hooks. Default 'origin/main'."),
    runTeardown: z.boolean().optional().describe("Run the `worktree.teardown` hooks before removal. Default true; teardown failures are logged, never blocking."),
    discardUntracked: z.boolean().optional().describe("Authorize discarding unignored untracked files. Default false: refuse if any are present."),
    discardModified: z.boolean().optional().describe("Authorize discarding modified tracked files (staged or unstaged). Default false: refuse if any are present."),
  }),
  outputSchema: z.object({
    removed: z.literal(true),
  }),
  mutates: ["fs:write"],
  approval: "auto",
  riskLevel: 2,
})
