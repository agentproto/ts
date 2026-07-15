/**
 * `agentproto worktree <subcommand>`
 *
 * Subcommands:
 *   ls        [--repo <dir>] [--status] [--json]    list this repo's git worktrees
 *   archive   <path> [--repo <dir>] [--base <ref>] tear a worktree down
 *             [--keep-branch] [--json]             (teardown hook → remove)
 *
 * Pure local shell over `@agentproto/worktree`: plain `ls` parses
 * `git worktree list --porcelain` (fast path, no forge round-trip); `ls
 * --status` additionally runs the status engine's reconciliation rule per
 * entry (PLAN.md §1.3 — tree/integration/liveness axes, provenance, class).
 * `archive` runs the `worktree.cleanup` tool, which stops any supervised
 * services, runs the committed `agentproto.json` teardown hooks, then
 * removes the worktree.
 */
import { parseArgs } from "node:util"
import { resolve, dirname } from "node:path"
import { spawnSync } from "node:child_process"
import { runTool } from "@agentproto/driver"
import {
  cleanupWorktreeTool,
  worktreeProvider,
  createForgeClient,
  FileVerdictMemoStore,
  listWorktreeStatuses,
  repoLabel,
  detectDefaultBranch,
  type WorktreeStatusEntry,
} from "@agentproto/worktree"

const USAGE = `agentproto worktree — inspect and tear down git worktrees

Usage:
  agentproto worktree ls      [--repo <dir>] [--status] [--json]
  agentproto worktree archive <path> [--repo <dir>] [--base <ref>]
                                     [--keep-branch] [--json]
  agentproto worktree --help

  ls        List the repo's git worktrees (path, branch, HEAD).
            --status adds the tree/integration/liveness axes, provenance,
            and reclaim/salvage/hold class per entry — a \`gh\`/GITHUB_TOKEN
            forge round-trip, memoised in ~/.agentproto/worktree-verdicts.json.
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

/** Resolve the git MAIN repo root that contains `dir`. Uses `--git-common-dir`
 * so it returns the true base repo even from a linked worktree — unlike
 * `--show-toplevel`, which would return the worktree path itself in that case. */
export function repoRootOf(dir: string): string | null {
  // `--path-format=absolute` is required: without it `--git-common-dir` returns
  // a RELATIVE ".git" from the main worktree, and `resolve(dirname("."))` would
  // then resolve against process.cwd() instead of `dir`. Forcing absolute makes
  // the parent-of-.git the true main repo root regardless of where we're run.
  const res = spawnSync(
    "git",
    ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  )
  if (res.status !== 0) return null
  const gitDir = res.stdout.trim()
  if (!gitDir) return null
  return resolve(dirname(gitDir))
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

async function runLs(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { repo: { type: "string" }, json: { type: "boolean" }, status: { type: "boolean" } },
  })

  const repoRoot = repoRootOf(resolve(values.repo ?? process.cwd()))
  if (!repoRoot) {
    process.stderr.write("agentproto worktree ls: not inside a git repository.\n")
    return 2
  }

  if (values.status) return runLsStatus(repoRoot, Boolean(values.json))

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

// ── ls --status ──────────────────────────────────────────────────────

/** `ls --status`: the full status engine (PLAN.md §1.3–§1.5) over every linked worktree of `repoRoot`. */
async function runLsStatus(repoRoot: string, json: boolean): Promise<number> {
  const [forge, defaultBranch] = await Promise.all([createForgeClient(repoRoot), detectDefaultBranch(repoRoot)])
  const entries = await listWorktreeStatuses({
    repoRoot,
    repoName: repoLabel(repoRoot),
    forge,
    memo: new FileVerdictMemoStore(),
    defaultBranchRef: `origin/${defaultBranch}`,
  })

  if (json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n")
    return 0
  }
  if (entries.length === 0) {
    process.stdout.write("No worktrees.\n")
    return 0
  }
  process.stdout.write(
    `${"BRANCH".padEnd(28)}  ${"CLASS".padEnd(9)}  ${"TREE".padEnd(16)}  ${"INTEGRATION".padEnd(26)}  ${"LIVENESS".padEnd(14)}  PATH\n`,
  )
  for (const e of entries) {
    process.stdout.write(formatStatusRow(e) + "\n")
  }
  return 0
}

function formatTree(tree: WorktreeStatusEntry["tree"]): string {
  if (tree.state === "clean") return "clean"
  return `dirty(${tree.modified}m/${tree.staged}s/${tree.untracked}u)`
}

function formatIntegration(integration: WorktreeStatusEntry["integration"]): string {
  const offlineSuffix = "offline" in integration && integration.offline ? ",offline" : ""
  switch (integration.state) {
    case "merged":
      return integration.via === "squash" ? `merged(squash,#${integration.pr}${offlineSuffix})` : "merged(ancestry)"
    case "partial":
      return `partial(#${integration.pr},+${integration.aheadBy}${offlineSuffix})`
    case "open":
      return `open(#${integration.pr}${offlineSuffix})`
    case "unpushed":
      return `unpushed(+${integration.aheadBy})`
    case "unknown":
      return "unknown(offline)"
    default:
      return integration.state
  }
}

function formatLiveness(liveness: WorktreeStatusEntry["liveness"]): string {
  if (liveness.state === "sessions") return `sessions(${liveness.sessions.length})`
  return liveness.state
}

function formatStatusRow(entry: WorktreeStatusEntry): string {
  const branch = entry.branch ?? "(detached)"
  return [
    branch.padEnd(28),
    entry.class.padEnd(9),
    formatTree(entry.tree).padEnd(16),
    formatIntegration(entry.integration).padEnd(26),
    formatLiveness(entry.liveness).padEnd(14),
    entry.path,
  ].join("  ")
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
