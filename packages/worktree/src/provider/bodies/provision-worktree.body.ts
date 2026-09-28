import { randomUUID } from "node:crypto"
import { mkdir, copyFile, symlink, lstat, appendFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { implementTool } from "@agentproto/driver"
import { ToolError } from "@agentproto/tool"
import { provisionWorktreeTool } from "../../tools/provision-worktree.tool.js"
import { execGit, execShell } from "../../exec.js"
import { expandGlob } from "../../glob.js"
import { loadConfigFromBase, normalizeHook } from "../../config.js"
import { loadLocalWorktreeConfig, resolveLocalWriteFiles } from "../../local-config.js"
import { cloneEntries } from "../../clone.js"
import { runSetup, HookError } from "../../lifecycle.js"
import { removeWorktreeFast } from "../../fast-remove.js"
import {
  ProvisionCancelledError,
  currentProvisionContext,
  provisionScheduler,
  type ProvisionLease,
  type ProvisionPhase,
  type ProvisionProgress,
} from "../../provision-scheduler.js"
import { writeWorktreeMarker } from "../../provenance.js"

/**
 * A cancelled provisioning is a half-built worktree nobody will ever use:
 * remove the one THIS call created (and its branch) so a killed spawn leaves
 * nothing behind. Best-effort, never throws; a failed (not cancelled)
 * provisioning keeps its worktree for inspection as before.
 */
async function discardCancelledWorktree(repoRoot: string, cwd: string, branch: string): Promise<void> {
  await removeWorktreeFast(repoRoot, cwd, { force: true }).catch(() => {})
  await execGit(repoRoot, ["branch", "-D", branch]).catch(() => {})
}

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

    // Declarative lifecycle config, read once from the base tree's committed
    // agentproto.json (never the working tree — see config.ts's SECURITY
    // note), and once more from the source checkout's LOCAL, host-owned
    // `.agentproto/worktree.json` (never the working tree of the fresh
    // worktree either — see local-config.ts's doc). Both gated on `runSetup`
    // since that flag is the opt-out for the whole declarative lifecycle, not
    // just the setup/teardown hooks. Loaded here (rather than at each call
    // site) so every caller of this tool — the CLI's `worktree new` and the
    // daemon's spawn-time provisioner alike — picks up a repo's declared
    // defaults automatically, without duplicating the load-and-merge logic
    // per call site. Precedence: explicit tool input > local worktree.json >
    // committed agentproto.json.
    const config = input.runSetup !== false ? await loadConfigFromBase(input.repoRoot, base) : null
    const localConfig =
      input.runSetup !== false ? await loadLocalWorktreeConfig(input.repoRoot) : null
    const linkPaths = input.linkPaths ?? localConfig?.linkPaths ?? config?.worktree?.linkPaths ?? []
    const depsCmd = input.depsCmd ?? localConfig?.depsCmd ?? config?.worktree?.depsCmd
    const copyGlobs = input.copyGlobs ?? localConfig?.copyGlobs ?? []
    const cloneGlobs = input.cloneGlobs ?? localConfig?.cloneGlobs ?? []
    // `copyGlobs`/`cloneGlobs`/`writeFiles` have no committed-agentproto.json
    // equivalent, so their fallback chain stops at the local file.
    const writeFiles = input.writeFiles ?? resolveLocalWriteFiles(localConfig?.writeFiles, input.slug)

    // Symlink gitignored, expensive-to-recreate trees from the host repo into
    // the worktree BEFORE depsCmd, so a workspace whose graph spans gitignored
    // dirs (sibling repos, node_modules) resolves without a full reinstall.
    for (const rel of linkPaths) {
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
    for (const file of writeFiles) {
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

    // Everything from here on is the HEAVY segment (clone, deps, copy, setup
    // hooks): it takes one slot from the daemon-wide scheduler so a burst of
    // spawns cannot run a dozen package-manager installs against one store at
    // once. The cheap prep above stays outside the slot. A run with nothing
    // heavy to do never queues.
    const ctx = currentProvisionContext()
    const signal = ctx?.signal
    const report = (progress: ProvisionProgress): void => {
      try {
        ctx?.onProgress?.(progress)
      } catch {
        // An observer must never break provisioning.
      }
    }
    const hasSetup = config ? normalizeHook(config.worktree?.setup).length > 0 : false
    const firstHeavy: ProvisionPhase | null =
      cloneGlobs.length > 0
        ? "clone"
        : depsCmd
          ? "deps"
          : copyGlobs.length > 0
            ? "copy"
            : hasSetup
              ? "setup"
              : null

    if (firstHeavy === null) {
      report({ kind: "done", outcome: "ok" })
      return { cwd, branch }
    }

    let phase: ProvisionPhase = firstHeavy
    let lease: ProvisionLease | undefined
    try {
      lease = await provisionScheduler.acquire({
        repoKey: resolve(input.repoRoot),
        ...(ctx?.callerKey ? { callerKey: ctx.callerKey } : {}),
        ...(signal ? { signal } : {}),
        onQueued: (position) => report({ kind: "queued", position, phase: firstHeavy }),
      })
      if (signal?.aborted) throw new ProvisionCancelledError()
      report({ kind: "started", phase })

      // Clone gitignored, expensive-to-recreate trees (e.g. node_modules) from
      // the source checkout BEFORE depsCmd, same ordering reasoning as
      // linkPaths/writeFiles above — except a clone is an independent,
      // writable copy (copy-on-write where the filesystem supports it), not a
      // symlink, so depsCmd can freely mutate it without touching the source
      // checkout, and a subsequent install becomes a quick verify/repair
      // rather than a full reinstall.
      if (cloneGlobs.length > 0) {
        phase = "clone"
        report({ kind: "phase", phase })
        try {
          await cloneEntries(input.repoRoot, cwd, cloneGlobs, signal)
        } catch (err) {
          if (err instanceof ProvisionCancelledError) throw err
          throw new ToolError({
            code: "execution_failed",
            message: `cloneGlobs failed: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
      }

      if (depsCmd) {
        phase = "deps"
        report({ kind: "phase", phase })
        const result = await execShell(depsCmd, cwd, signal ? { signal } : {})
        // A killed install exits non-zero; that is a cancellation, not a failure.
        if (signal?.aborted) throw new ProvisionCancelledError()
        if (result.exitCode !== 0) {
          throw new ToolError({
            code: "execution_failed",
            message: `depsCmd '${depsCmd}' failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
          })
        }
      }

      if (copyGlobs.length > 0) {
        phase = "copy"
        report({ kind: "phase", phase })
        for (const pattern of copyGlobs) {
          const matches = await expandGlob(input.repoRoot, pattern)
          for (const rel of matches) {
            if (signal?.aborted) throw new ProvisionCancelledError()
            const dest = join(cwd, rel)
            await mkdir(dirname(dest), { recursive: true })
            await copyFile(join(input.repoRoot, rel), dest)
          }
        }
      }

      // Declarative lifecycle: run the repo's committed `agentproto.json` setup
      // hooks in the fresh worktree. `config` was already loaded above (same
      // `runSetup` gate) — reused here rather than re-reading the base tree.
      if (config && hasSetup) {
        phase = "setup"
        report({ kind: "phase", phase })
        try {
          await runSetup(
            config,
            {
              sourceCheckoutPath: input.repoRoot,
              worktreePath: cwd,
              branchName: branch,
            },
            {
              ...(input.setupLogPath ? { logPath: input.setupLogPath } : {}),
              ...(input.retrySetupOnFailure ? { retryOnFailure: true } : {}),
              ...(signal ? { signal } : {}),
            },
          )
        } catch (err) {
          if (err instanceof HookError) {
            throw new ToolError({ code: "execution_failed", message: err.message })
          }
          throw err
        }
      }
    } catch (err) {
      const cancelled = err instanceof ProvisionCancelledError
      report({ kind: "done", outcome: cancelled ? "cancelled" : "failed" })
      if (cancelled) await discardCancelledWorktree(input.repoRoot, cwd, branch)
      throw err
    } finally {
      lease?.release()
    }

    report({ kind: "done", outcome: "ok" })
    return { cwd, branch }
  },
)
