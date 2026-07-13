/**
 * `agentproto worktree <subcommand>`
 *
 * Subcommands:
 *   ls        [--repo <dir>] [--json]              list this repo's git worktrees
 *   archive   <path> [--repo <dir>] [--base <ref>] tear a worktree down
 *             [--keep-branch] [--json]             (teardown hook → remove)
 *
 * Pure local shell over `@agentproto/worktree`: `ls` parses
 * `git worktree list --porcelain`; `archive` runs the `worktree.cleanup`
 * tool, which stops any supervised services, runs the committed
 * `agentproto.json` teardown hooks, then removes the worktree.
 */
import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { runTool } from "@agentproto/driver"
import { cleanupWorktreeTool, worktreeProvider } from "@agentproto/worktree"

const USAGE = `agentproto worktree — inspect and tear down git worktrees

Usage:
  agentproto worktree ls      [--repo <dir>] [--json]
  agentproto worktree archive <path> [--repo <dir>] [--base <ref>]
                                     [--keep-branch] [--json]
  agentproto worktree --help

  ls        List the repo's git worktrees (path, branch, HEAD).
  archive   Stop the worktree's services, run its agentproto.json teardown
            hooks, then remove it. Also deletes its branch unless
            --keep-branch. --base picks the ref whose committed teardown
            hooks run (default origin/main).
`

const candidates = [worktreeProvider]

export async function runWorktree(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = args[0]
  if (sub === "ls" || sub === "list") return runLs(args.slice(1))
  if (sub === "archive" || sub === "rm" || sub === "remove") return runArchive(args.slice(1))

  if (!sub) {
    process.stdout.write(USAGE)
    return 0
  }
  process.stderr.write(
    `agentproto worktree: unknown subcommand "${sub}"\n  Known: ls | archive\n`,
  )
  return 2
}

/** Resolve the git repo root that contains `dir` (top-level of the worktree). */
function repoRootOf(dir: string): string | null {
  const res = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  })
  if (res.status !== 0) return null
  return res.stdout.trim() || null
}

interface WorktreeEntry {
  path: string
  branch: string | null
  head: string | null
}

/** Parse `git worktree list --porcelain` into structured entries. */
function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current)
      current = { path: line.slice("worktree ".length), branch: null, head: null }
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length)
    } else if (current && line === "detached") {
      current.branch = "(detached)"
    }
  }
  if (current) entries.push(current)
  return entries
}

// ── ls ────────────────────────────────────────────────────────────────

function runLs(args: readonly string[]): number {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { repo: { type: "string" }, json: { type: "boolean" } },
  })

  const repoRoot = repoRootOf(resolve(values.repo ?? process.cwd()))
  if (!repoRoot) {
    process.stderr.write("agentproto worktree ls: not inside a git repository.\n")
    return 2
  }

  const res = spawnSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  })
  if (res.status !== 0) {
    process.stderr.write(`agentproto worktree ls: ${res.stderr.trim() || "git failed"}\n`)
    return 1
  }
  const entries = parseWorktreeList(res.stdout)

  if (values.json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n")
    return 0
  }
  if (entries.length === 0) {
    process.stdout.write("No worktrees.\n")
    return 0
  }
  process.stdout.write(`${"BRANCH".padEnd(28)}  ${"HEAD".padEnd(10)}  PATH\n`)
  for (const e of entries) {
    const head = (e.head ?? "").slice(0, 10)
    process.stdout.write(`${(e.branch ?? "—").padEnd(28)}  ${head.padEnd(10)}  ${e.path}\n`)
  }
  return 0
}

// ── archive ─────────────────────────────────────────────────────────────

async function runArchive(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      "keep-branch": { type: "boolean" },
      json: { type: "boolean" },
    },
  })

  const target = positionals[0]
  if (!target) {
    process.stderr.write(
      "agentproto worktree archive: missing worktree path.\n" +
        "  Try: agentproto worktree archive <path>  (see `agentproto worktree ls`)\n",
    )
    return 2
  }
  const cwd = resolve(target)

  // The repo root that owns the worktree — prefer --repo, else derive from the
  // worktree's own git metadata (its main working tree).
  const repoRoot = repoRootOf(resolve(values.repo ?? cwd))
  if (!repoRoot) {
    process.stderr.write(
      `agentproto worktree archive: could not resolve the git repo for "${target}".\n`,
    )
    return 2
  }

  // The branch the worktree is on, so cleanup can delete it.
  const branchRes = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  })
  const branch = branchRes.status === 0 ? branchRes.stdout.trim() : undefined

  try {
    await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: {
        repoRoot,
        cwd,
        ...(branch && branch !== "HEAD" ? { branch } : {}),
        deleteBranch: !values["keep-branch"],
        ...(values.base !== undefined ? { base: values.base } : {}),
      },
    })
  } catch (err) {
    process.stderr.write(
      `agentproto worktree archive: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify({ archived: cwd, branch: branch ?? null }, null, 2) + "\n")
  } else {
    process.stdout.write(`worktree archived  ${cwd}${branch ? `  (branch ${branch})` : ""}\n`)
  }
  return 0
}
