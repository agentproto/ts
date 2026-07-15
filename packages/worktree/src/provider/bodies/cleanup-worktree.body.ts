import { implementTool } from "@agentproto/driver"
import { cleanupWorktreeTool } from "../../tools/cleanup-worktree.tool.js"
import { execGit } from "../../exec.js"
import { loadConfigFromBase } from "../../config.js"
import { runTeardown } from "../../lifecycle.js"
import { disposeSupervisor } from "../../services/runtime.js"
import { computeTreeState } from "../../status.js"

/**
 * Raised when `worktree.cleanup` can't remove the worktree: either we
 * categorized the tree ourselves and found a dirty class the caller didn't
 * authorize (`blocked` names it), or — the no-flags default path — git's own
 * `worktree remove` refused and we never asked why (`blocked` is empty,
 * `message` carries git's stderr verbatim).
 */
export class WorktreeNotRemovableError extends Error {
  readonly cwd: string
  readonly blocked: readonly ("untracked" | "modified")[]

  /**
   * `blocked` is empty when git itself refused without us categorizing the
   * tree first (the no-flags default path, PLAN.md §5.2 layer 3) — `detail`
   * then carries git's own stderr instead of a named class.
   */
  constructor(cwd: string, blocked: readonly ("untracked" | "modified")[], detail?: string) {
    const flags = blocked.map((b) => (b === "untracked" ? "discardUntracked" : "discardModified"))
    const message =
      blocked.length > 0
        ? `worktree at ${cwd} has ${blocked.join(" and ")} changes; refusing to remove. ` +
          `Pass ${flags.join(" and ")} to authorize discarding ${blocked.length > 1 ? "them" : "it"}, ` +
          `or use 'worktree archive' to salvage first.`
        : `worktree at ${cwd} is not clean; git refused to remove it${detail ? `: ${detail}` : ""}. ` +
          `Pass discardUntracked/discardModified to authorize discarding, or use 'worktree archive' to salvage first.`
    super(message)
    this.name = "WorktreeNotRemovableError"
    this.cwd = cwd
    this.blocked = blocked
  }
}

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

    const discardUntracked = input.discardUntracked === true
    const discardModified = input.discardModified === true

    if (discardUntracked || discardModified) {
      // At least one discard flag is set: git's own `--force` is all-or-
      // nothing, so we categorize the tree ourselves first to make sure the
      // granted flag(s) actually cover everything dirty before force-passing
      // — otherwise a lone `discardUntracked` could silently also destroy
      // modified tracked files it never authorized.
      const tree = await computeTreeState(input.cwd)
      if (tree.state === "dirty") {
        const blocked: ("untracked" | "modified")[] = []
        if (tree.untracked > 0 && !discardUntracked) blocked.push("untracked")
        if ((tree.modified > 0 || tree.staged > 0) && !discardModified) blocked.push("modified")
        if (blocked.length > 0) throw new WorktreeNotRemovableError(input.cwd, blocked)
        await execGit(input.repoRoot, ["worktree", "remove", "--force", input.cwd])
      } else {
        await execGit(input.repoRoot, ["worktree", "remove", input.cwd])
      }
    } else {
      // No discard flag: git's own refusal is the final arbiter (PLAN.md
      // §5.2 layer 3) — no need to re-implement the dirty check here. A
      // clean tree (or one with only gitignored files) removes fine; a
      // dirty one makes git itself fail, which we surface as the same typed
      // error without claiming to know which class blocked it (we never
      // asked).
      try {
        await execGit(input.repoRoot, ["worktree", "remove", input.cwd])
      } catch (err) {
        throw new WorktreeNotRemovableError(input.cwd, [], err instanceof Error ? err.message : String(err))
      }
    }

    if (input.deleteBranch && input.branch) {
      await execGit(input.repoRoot, ["branch", "-D", input.branch])
    }
    return { removed: true as const }
  },
)
