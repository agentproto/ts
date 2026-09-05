import { randomUUID } from "node:crypto"
import { mkdir, copyFile, symlink, lstat, appendFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { implementTool } from "@agentproto/driver"
import { ToolError } from "@agentproto/tool"
import { provisionWorktreeTool } from "../../tools/provision-worktree.tool.js"
import { execGit, execShell } from "../../exec.js"
import { expandGlob } from "../../glob.js"
import { loadConfigFromBase } from "../../config.js"
import { runSetup, HookError } from "../../lifecycle.js"
import { writeWorktreeMarker } from "../../provenance.js"

export const provisionWorktreeBuiltin = implementTool(
  provisionWorktreeTool,
  async ({ input }) => {
    const base = input.base ?? "origin/main"
    const branch = input.branch ?? `wt/${input.slug}`
    const cwd = input.dir ? resolve(input.dir) : resolve(input.repoRoot, "..", "_worktrees", input.slug)

    await execGit(input.repoRoot, ["worktree", "add", "-b", branch, cwd, base])

    // PLAN.md §1.5: the creation marker, written once, right after the
    // worktree exists. Lives in the worktree's own private gitdir, so it
    // dies with `git worktree remove`/`prune` and never shows up in `git
    // status` — colocated with the artifact it describes, not a registry.
    // `createdBySessionId` is omitted: nothing in this codebase threads a
    // session id into `worktree.provision` today (it runs before any
    // session is spawned into the worktree), and recording a guess would be
    // worse than the honest `best-effort` provenance callers already fall
    // back to.
    await writeWorktreeMarker(input.repoRoot, cwd, {
      worktreeId: `wt_${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
    })

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

    // Write generated, worktree-specific config BEFORE depsCmd, so a tool it
    // invokes (e.g. a package manager) sees it on first run.
    for (const file of input.writeFiles ?? []) {
      const dest = join(cwd, file.path)
      await mkdir(dirname(dest), { recursive: true })
      if (file.mode === "append") {
        await appendFile(dest, file.content)
        // Mark skip-worktree so this worktree-local tweak to a (likely)
        // tracked file never shows up as a modification the caller could
        // accidentally commit. Best-effort: a no-op path (never tracked to
        // begin with) makes `update-index --skip-worktree` fail — that's
        // fine, there's nothing to hide from `git status` for it anyway.
        await execGit(cwd, ["update-index", "--skip-worktree", file.path]).catch(() => {})
      } else {
        const existing = await lstat(dest).catch(() => null)
        if (existing) continue
        await writeFile(dest, file.content)
      }
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
