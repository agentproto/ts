import { implementTool } from "@agentproto/driver"
import { cleanupWorktreeTool } from "../../tools/cleanup-worktree.tool.js"
import { execGit } from "../../exec.js"
import { loadConfigFromBase } from "../../config.js"
import { runTeardown } from "../../lifecycle.js"
import { disposeSupervisor } from "../../services/runtime.js"

export const cleanupWorktreeBuiltin = implementTool(
  cleanupWorktreeTool,
  async ({ input }) => {
    // Stop any supervised services for this worktree before we tear anything
    // down — orphaned children would otherwise keep ports (and the proxy
    // route) held after the directory is gone.
    await disposeSupervisor(input.cwd)

    // Declarative lifecycle: run teardown hooks (from the base tree's
    // agentproto.json) while the worktree still exists. Teardown failures are
    // logged, never blocking — cleanup's whole job is to tear the dir down.
    if (input.runTeardown !== false) {
      const config = await loadConfigFromBase(input.repoRoot, input.base).catch(() => null)
      if (config) {
        const runs = await runTeardown(config, {
          sourceCheckoutPath: input.repoRoot,
          worktreePath: input.cwd,
          branchName: input.branch ?? "",
        }).catch((err: unknown) => {
          process.stderr.write(
            `worktree.cleanup: teardown hook error (ignored): ${err instanceof Error ? err.message : String(err)}\n`,
          )
          return []
        })
        for (const run of runs) {
          if (run.result.exitCode !== 0) {
            process.stderr.write(
              `worktree.cleanup: teardown '${run.command}' exited ${run.result.exitCode} (ignored): ` +
                `${(run.result.stderr || run.result.stdout).trim()}\n`,
            )
          }
        }
      }
    }

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
