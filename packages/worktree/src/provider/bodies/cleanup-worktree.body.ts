import { implementTool } from "@agentproto/driver"
import { cleanupWorktreeTool } from "../../tools/cleanup-worktree.tool.js"
import { execGit } from "../../exec.js"

export const cleanupWorktreeBuiltin = implementTool(
  cleanupWorktreeTool,
  async ({ input }) => {
    // --force: a provisioned worktree almost always carries untracked files
    // by the time cleanup runs (installed deps, copied secrets, agent output)
    // — plain `worktree remove` refuses those. Cleanup's whole job is to
    // tear the directory down regardless.
    await execGit(input.repoRoot, ["worktree", "remove", "--force", input.cwd])
    if (input.deleteBranch && input.branch) {
      await execGit(input.repoRoot, ["branch", "-D", input.branch])
    }
    return { removed: true as const }
  },
)
