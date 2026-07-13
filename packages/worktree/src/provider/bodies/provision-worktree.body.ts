import { mkdir, copyFile, symlink, lstat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { implementTool } from "@agentproto/driver"
import { ToolError } from "@agentproto/tool"
import { provisionWorktreeTool } from "../../tools/provision-worktree.tool.js"
import { execGit, execShell } from "../../exec.js"
import { expandGlob } from "../../glob.js"
import { loadConfigFromBase } from "../../config.js"
import { runSetup, HookError } from "../../lifecycle.js"

export const provisionWorktreeBuiltin = implementTool(
  provisionWorktreeTool,
  async ({ input }) => {
    const base = input.base ?? "origin/main"
    const branch = `wt/${input.slug}`
    const cwd = resolve(input.repoRoot, "..", "_worktrees", input.slug)

    await execGit(input.repoRoot, ["worktree", "add", "-b", branch, cwd, base])

    // Symlink gitignored, expensive-to-recreate trees from the host repo into
    // the worktree BEFORE depsCmd, so a workspace whose graph spans gitignored
    // dirs (sibling repos, node_modules) resolves without a full reinstall.
    for (const rel of input.linkPaths ?? []) {
      const target = resolve(input.repoRoot, rel)
      const dest = join(cwd, rel)
      // A fresh worktree shouldn't already carry a gitignored path; if it does
      // (a tracked dir, or a re-run), leave it untouched rather than clobber.
      const existing = await lstat(dest).catch(() => null)
      if (existing) continue
      await mkdir(dirname(dest), { recursive: true })
      await symlink(target, dest, "dir")
    }

    if (input.depsCmd) {
      const result = await execShell(input.depsCmd, cwd)
      if (result.exitCode !== 0) {
        throw new ToolError({
          code: "execution_failed",
          message: `depsCmd '${input.depsCmd}' failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
        })
      }
    }

    for (const pattern of input.copyGlobs ?? []) {
      const matches = await expandGlob(input.repoRoot, pattern)
      for (const rel of matches) {
        const dest = join(cwd, rel)
        await mkdir(dirname(dest), { recursive: true })
        await copyFile(join(input.repoRoot, rel), dest)
      }
    }

    // Declarative lifecycle: run the repo's committed `agentproto.json` setup
    // hooks in the fresh worktree. Read from the base tree (never the working
    // tree) so a branch/agent can't inject host-side commands. A failing setup
    // hook fails provisioning, carrying the captured output.
    if (input.runSetup !== false) {
      const config = await loadConfigFromBase(input.repoRoot, base)
      if (config) {
        try {
          await runSetup(config, {
            sourceCheckoutPath: input.repoRoot,
            worktreePath: cwd,
            branchName: branch,
          })
        } catch (err) {
          if (err instanceof HookError) {
            throw new ToolError({ code: "execution_failed", message: err.message })
          }
          throw err
        }
      }
    }

    return { cwd, branch }
  },
)
