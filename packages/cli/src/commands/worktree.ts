/**
 * `agentproto worktree <subcommand>`
 *
 * Subcommands:
 *   ls        [--repo <dir>] [--status] [--json]     list this repo's git worktrees
 *   new       <slug> [--repo <dir>] [--base <ref>]    create a worktree under
 *             [--branch <name>] [--no-setup] [--json]  worktrees.root (PLAN.md §1.4/§4)
 *   rm    <path|slug> [--repo <dir>] [--base <ref>]    the guarded destructive verb —
 *             [--keep-branch] [--discard-untracked]  refuses a dirty tree unless the
 *             [--discard-modified] [--json]           matching flag is given
 *   archive <path|slug> [--repo <dir>] [--base <ref>]  salvage-then-remove: snapshots
 *             [--keep-branch] [--json]                uncommitted state first
 *
 * Pure local shell over `@agentproto/worktree`: plain `ls` parses
 * `git worktree list --porcelain` (fast path, no forge round-trip); `ls
 * --status` additionally runs the status engine's reconciliation rule per
 * entry (PLAN.md §1.3 — tree/integration/liveness axes, provenance, class).
 *
 * `new` is a thin shell over the `worktree.provision` tool: it resolves
 * `worktrees.root` (§1.4) and passes `<root>/<repoName>/<slug>` as the
 * tool's `dir` input, so every worktree this verb creates lands under one
 * root regardless of where the repo itself lives. `rm`/`archive` take a
 * worktree `<path>` and derive everything from that path's own git metadata
 * — so they can also tear down the worktrees `new` didn't create (every
 * pre-existing one, scattered across whatever root its own session picked;
 * PLAN.md §5.3 drains those by attrition through these same verbs, not a
 * migration). When the positional isn't a path but a bare `<slug>` (or its
 * `wt/<slug>` branch spelling), they fall back to the *same* `worktrees.root`
 * `new` writes to — `<root>/<repoLabel>/<slug>` — so `rm <slug>` resolves the
 * owning repo from a cwd outside it, not only from within.
 *
 * `rm` and `archive` are deliberately different verbs (PLAN.md §5.2): `rm`
 * is the honest plain-destructive one — it runs `worktree.cleanup` and
 * refuses a dirty tree unless `--discard-untracked`/`--discard-modified`
 * authorizes the class of change present. `archive` re-earns its old name:
 * it snapshots the tree's uncommitted state to
 * `~/.agentproto/worktree-salvage/` (via `salvageWorktree`) *before* calling
 * `worktree.cleanup` with both discard flags granted, so nothing still on
 * disk is lost to the removal.
 */
import { parseArgs } from "node:util"
import { randomUUID } from "node:crypto"
import { resolve, dirname, basename, join } from "node:path"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { execFile, spawnSync } from "node:child_process"
import { runTool } from "@agentproto/driver"
import { loadConfig } from "@agentproto/runtime/config"
import type {
  WorktreeProvisioner,
  WorktreeProvisionRequest,
  WorktreeProvisionOutcome,
} from "@agentproto/runtime"
import {
  provisionWorktreeTool,
  cleanupWorktreeTool,
  worktreeProvider,
  createForgeClient,
  parseGithubOwnerRepo,
  FileVerdictMemoStore,
  listWorktreeStatuses,
  repoLabel,
  detectDefaultBranch,
  salvageWorktree,
  WorktreeNotRemovableError,
  planGc,
  applyGc,
  type WorktreeStatusEntry,
  type GcPlanEntry,
  type GcApplyOutcome,
} from "@agentproto/worktree"
import {
  toWorktreeStatusView,
  type WorktreeStatusLister,
  type WorktreeStatusView,
  type WorktreeGcRunner,
  type WorktreeGcResult,
  type WorktreeGcPlanEntryView,
  type WorktreeGcOutcomeView,
  type OpenPrResolver,
  type PrStateResolver,
  type PrResolvedState,
} from "@agentproto/runtime"

const USAGE = `agentproto worktree — create, inspect, and tear down git worktrees

Usage:
  agentproto worktree ls      [--repo <dir>] [--status] [--json]
  agentproto worktree new     <slug> [--repo <dir>] [--base <ref>]
                                     [--branch <name>] [--no-setup] [--json]
  agentproto worktree rm      <path|slug> [--repo <dir>] [--base <ref>] [--keep-branch]
                                     [--discard-untracked] [--discard-modified] [--json]
  agentproto worktree archive <path|slug> [--repo <dir>] [--base <ref>]
                                     [--keep-branch] [--json]
  agentproto worktree gc      [--repo <dir>] [--apply] [--salvage-dirty]
                                     [--include-detached] [--json]
  agentproto worktree --help

  ls        List the repo's git worktrees (path, branch, HEAD).
            --status adds the tree/integration/liveness axes, provenance,
            and reclaim/salvage/hold class per entry — a \`gh\`/GITHUB_TOKEN
            forge round-trip, memoised in ~/.agentproto/worktree-verdicts.json.
  new       Create a worktree at <worktrees.root>/<repoName>/<slug>, on
            branch --branch (default wt/<slug>) cut from --base (default
            origin/main). worktrees.root resolves as --root flag > env
            AGENTPROTO_WORKTREES_ROOT > config.json \`worktrees.root\` >
            ~/.agentproto/worktrees. Writes a creation-provenance marker
            into the worktree's private gitdir.
  rm        Stop the worktree's services, run its agentproto.json teardown
            hooks, then remove it. Refuses if the tree has modified tracked
            files or unignored untracked files, unless --discard-modified /
            --discard-untracked authorizes it. Also deletes its branch
            unless --keep-branch. --base picks the ref whose committed
            teardown hooks run (default origin/main).
  archive   Snapshot the worktree's uncommitted state under
            ~/.agentproto/worktree-salvage/ (changes.patch + a copy of every
            untracked file + MANIFEST.json), then run the same removal as
            \`rm\` with both discard flags granted — nothing on disk is lost.
  gc        Classify every linked worktree into reclaim ((merged|fresh)+clean+idle) /
            salvage (merged+dirty, and not written to in the last 15m) /
            hold (everything else — including a fresh or merged branch with
            uncommitted work), then print the plan. DRY RUN by default —
            nothing is touched without --apply. --apply removes every
            reclaim-class worktree (plain, non-force \`git worktree remove\`
            — refuses if the tree turned dirty since the plan was made) and
            deletes its branch. --salvage-dirty additionally archives every
            salvage-class worktree (salvage snapshot, then remove — same as
            \`archive\`).
            hold-class worktrees are never touched, with or without flags.
            --include-detached also reclaims clean, idle detached worktrees.
`

const candidates = [worktreeProvider]

export async function runWorktree(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = args[0]
  if (sub === "ls" || sub === "list") return runLs(args.slice(1))
  if (sub === "new") return runNew(args.slice(1))
  if (sub === "rm" || sub === "remove") return runRm(args.slice(1))
  if (sub === "archive") return runArchive(args.slice(1))
  if (sub === "gc") return runGc(args.slice(1))

  if (!sub) {
    process.stdout.write(USAGE)
    return 0
  }
  process.stderr.write(
    `agentproto worktree: unknown subcommand "${sub}"\n  Known: ls | new | rm | archive | gc\n`,
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
      return `merged(squash,#${integration.pr}${offlineSuffix})`
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

// ── new ──────────────────────────────────────────────────────────────────

/**
 * `worktrees.root` resolution — the same precedence every other knob in
 * `~/.agentproto/config.json` follows (flag > env > config.json > hardcoded
 * default, see that module's docblock). The default is a real, single root
 * (`~/.agentproto/worktrees`, alongside the rest of agentproto's per-user
 * state) rather than "unset" — a `worktree new` with zero configuration
 * still converges every worktree to one place, which is the actual fix for
 * the sprawl PLAN.md measured (31 worktrees under 6 different hand-picked
 * parents, because nothing before this verb gave anyone a place to agree on).
 */
export async function resolveWorktreesRoot(flag: string | undefined, configPath?: string): Promise<string> {
  if (flag) return resolve(flag)
  const envRoot = process.env["AGENTPROTO_WORKTREES_ROOT"]
  if (envRoot) return resolve(envRoot)
  const cfg = await loadConfig(configPath)
  if (cfg.worktrees?.root) return resolve(cfg.worktrees.root)
  return join(homedir(), ".agentproto", "worktrees")
}

/**
 * Auto-mint a collision-free worktree slug from an optional label hint —
 * `<slugified-label>-<8 hex>`, or `agent-<8 hex>` when the label yields
 * nothing usable. The random suffix makes a collision astronomically
 * unlikely; if one lands anyway, `git worktree add` fails LOUD (the dir /
 * branch already exists) rather than silently reusing another agent's tree,
 * so correctness never rests on the randomness alone. Kept ≤ the tool's
 * `^[a-z0-9][a-z0-9-]*$` slug shape.
 */
export function mintWorktreeSlug(labelHint?: string): string {
  const suffix = randomUUID().slice(0, 8)
  const base = (labelHint ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32)
    .replace(/-+$/, "")
  return base ? `${base}-${suffix}` : `agent-${suffix}`
}

/**
 * Concrete `WorktreeProvisioner` for the daemon — the injected port behind
 * `agent_start.worktree` and the `worktrees.isolation` policy. It lives in the
 * CLI (not `@agentproto/runtime`) precisely because it runs the
 * `worktree.provision` TOOL over `@agentproto/worktree`, the heavy dependency
 * the runtime deliberately refuses to take (see runtime's
 * `worktree-identity.ts` / `worktree-isolation.ts`). Resolves the owning repo
 * from the spawn's cwd — returning `not-a-git-repo` when there is none, so the
 * spawn lands plain — lands the worktree under the same `worktrees.root` as
 * `worktree new`, and returns the worktree's cwd for the session to adopt.
 */
export function makeWorktreeProvisioner(): WorktreeProvisioner {
  return async (req: WorktreeProvisionRequest): Promise<WorktreeProvisionOutcome> => {
    const repoRoot = repoRootOf(resolve(req.cwd))
    if (!repoRoot) return { isolated: false, reason: "not-a-git-repo" }
    const slug = req.slug ?? mintWorktreeSlug(req.labelHint)
    const root = await resolveWorktreesRoot(undefined)
    const dir = join(root, repoLabel(repoRoot), slug)
    const provisioned = await runTool({
      tool: provisionWorktreeTool,
      candidates,
      input: {
        repoRoot,
        slug,
        dir,
        ...(req.base !== undefined ? { base: req.base } : {}),
      },
    })
    return { isolated: true, cwd: provisioned.cwd, branch: provisioned.branch }
  }
}

/**
 * Concrete `WorktreeStatusLister` for the daemon — the injected port behind
 * `worktree_status` and `GET /worktrees`. Lives in the CLI (not the runtime)
 * because it runs the `listWorktreeStatuses` join over `@agentproto/worktree`,
 * the heavy dependency the runtime deliberately refuses to take. Mirrors the
 * construction used by `agentproto worktree ls --status`: resolves the owning
 * repo from the requested path, builds a forge client + file verdict memo, and
 * projects the raw entries through `toWorktreeStatusView`.
 */
export function makeWorktreeStatusLister(): WorktreeStatusLister {
  return async (repoRootCandidate: string): Promise<WorktreeStatusView[]> => {
    const repoRoot = repoRootOf(resolve(repoRootCandidate))
    if (!repoRoot) {
      throw new Error(
        `worktree_status: "${repoRootCandidate}" is not inside a git repository.`
      )
    }
    const [forge, defaultBranch] = await Promise.all([
      createForgeClient(repoRoot),
      detectDefaultBranch(repoRoot),
    ])
    const entries = await listWorktreeStatuses({
      repoRoot,
      repoName: repoLabel(repoRoot),
      forge,
      memo: new FileVerdictMemoStore(),
      defaultBranchRef: `origin/${defaultBranch}`,
    })
    return entries.map(toWorktreeStatusView)
  }
}

/** Runtime-local projection of one `GcPlanEntry` — flattens the engine's rich
 *  tree/integration/liveness objects to the discriminants the runtime carries. */
function toGcPlanEntryView(entry: GcPlanEntry): WorktreeGcPlanEntryView {
  const integration: { state: string; pr?: number } = { state: entry.integration.state }
  if ("pr" in entry.integration) integration.pr = entry.integration.pr
  return {
    path: entry.path,
    branch: entry.branch,
    head: entry.head,
    class: entry.class,
    tree: entry.tree.state,
    integration,
    liveness: {
      state: entry.liveness.state,
      sessionCount: entry.liveness.sessions.length,
    },
  }
}

/** Runtime-local projection of one `GcApplyOutcome` — preserves every
 *  discriminant `result` and only the extra fields that variant carries. */
function toGcOutcomeView(outcome: GcApplyOutcome): WorktreeGcOutcomeView {
  const base = { path: outcome.path, branch: outcome.branch }
  switch (outcome.result) {
    case "salvaged":
      return { ...base, result: outcome.result, salvageDir: outcome.salvageDir }
    case "aborted-reclassified":
      return { ...base, result: outcome.result, from: outcome.from, to: outcome.to }
    case "failed":
      return { ...base, result: outcome.result, message: outcome.message }
    default:
      return { ...base, result: outcome.result }
  }
}

/**
 * Concrete `WorktreeGcRunner` for the daemon — the injected port behind
 * `worktree_gc` and `POST /worktrees/gc`. Lives in the CLI (not the runtime)
 * because it runs the `planGc` / `applyGc` engine over `@agentproto/worktree`,
 * the heavy dependency the runtime deliberately refuses to take. Mirrors the
 * exact construction used by `agentproto worktree gc`: resolves the owning
 * repo, wires the same forge/memo/default-branch `gc` uses, always plans, and
 * only applies when `apply` is set. Defaulting to a dry run is enforced at the
 * tool/route boundary (`apply` defaults false); this runner just honors it.
 */
export function makeWorktreeGcRunner(): WorktreeGcRunner {
  return async ({
    repoRoot: repoRootCandidate,
    apply,
    salvageDirty,
    includeDetached,
  }): Promise<WorktreeGcResult> => {
    const repoRoot = repoRootOf(resolve(repoRootCandidate))
    if (!repoRoot) {
      throw new Error(
        `worktree_gc: "${repoRootCandidate}" is not inside a git repository.`
      )
    }
    const [forge, defaultBranch] = await Promise.all([
      createForgeClient(repoRoot),
      detectDefaultBranch(repoRoot),
    ])
    const repoName = repoLabel(repoRoot)
    const memo = new FileVerdictMemoStore()
    const defaultBranchRef = `origin/${defaultBranch}`

    const plan = await planGc({
      repoRoot,
      repoName,
      forge,
      memo,
      defaultBranchRef,
      includeDetached,
    })

    if (!apply) {
      return { mode: "plan", plan: plan.map(toGcPlanEntryView) }
    }

    const outcomes = await applyGc(plan, {
      repoRoot,
      repoName,
      forge,
      memo,
      defaultBranchRef,
      includeDetached,
      salvageDirty,
    })
    return { mode: "apply", outcomes: outcomes.map(toGcOutcomeView) }
  }
}

/**
 * Concrete {@link OpenPrResolver} for the daemon PR-provenance reconciler:
 * given a session cwd, resolve the OPEN PR whose head is that cwd's git branch,
 * reusing the same forge client the worktree-status join uses. Any failure —
 * not a git repo, detached HEAD, unreachable forge, non-GitHub origin — is a
 * `null` ("no PR right now"), never a throw (the reconciler is best-effort).
 * The PR url is built from the `origin` remote so no extra `gh` call is needed.
 */
export function makeOpenPrResolver(): OpenPrResolver {
  return async (cwd: string): Promise<{ number: number; url: string } | null> => {
    try {
      const repoRoot = repoRootOf(resolve(cwd))
      if (!repoRoot) return null
      const branch = worktreeBranch(cwd)
      if (!branch) return null
      const forge = await createForgeClient(repoRoot)
      const open = (await forge.pullRequestsForBranch(branch))
        .filter(pr => pr.state === "open")
        .sort((a, b) => a.number - b.number)[0]
      if (!open) return null
      const remote = spawnSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
        encoding: "utf8",
      })
      const parsed = remote.status === 0 ? parseGithubOwnerRepo(remote.stdout.trim()) : null
      if (!parsed) return null
      return {
        number: open.number,
        url: `https://github.com/${parsed.owner}/${parsed.repo}/pull/${open.number}`,
      }
    } catch {
      return null
    }
  }
}

/**
 * Concrete {@link PrStateResolver} for the Activity projector's PR settlement
 * pass: given a PR url, resolve its current forge state. Asks `gh pr view
 * <url> --json state` — the url form needs no repo cwd and inherits the
 * caller's own `gh auth` session, the same zero-config posture as
 * `GhCliForgeClient` (`ForgeClient`'s branch/commit verbs can't answer a
 * lone PR NUMBER, and `createForgeClient` needs a repoRoot this port doesn't
 * have — a url is all the projector knows). Async `execFile`, not
 * `spawnSync`: this runs inside the daemon on a periodic sweep, so it must
 * not block the event loop per PR. A MERGED/CLOSED verdict is immutable, so
 * it is memoised for the daemon's lifetime (the worktree verdict-memo
 * rationale, in-memory — the projector caches too, but a restart-fresh
 * projector re-asks through here). Any failure — non-GitHub url, missing/
 * unauthenticated `gh`, unreachable forge — is `null` ("unknown right now"),
 * never a throw (the settlement pass is best-effort).
 */
export function makePrStateResolver(): PrStateResolver {
  const verdicts = new Map<string, Extract<PrResolvedState, "merged" | "closed">>()
  return async (prUrl: string): Promise<PrResolvedState | null> => {
    const memo = verdicts.get(prUrl)
    if (memo) return memo
    // Cheap shape guard so garbage never spawns a process. GitHub-only for
    // now — mirrors makeOpenPrResolver's parseGithubOwnerRepo scope.
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(prUrl)) return null
    const raw = await new Promise<string | null>(resolvePromise => {
      execFile(
        "gh",
        ["pr", "view", prUrl, "--json", "state", "--jq", ".state"],
        { encoding: "utf8" },
        (err, stdout) => resolvePromise(err ? null : stdout),
      )
    })
    if (raw === null) return null
    switch (raw.trim().toUpperCase()) {
      case "MERGED":
        verdicts.set(prUrl, "merged")
        return "merged"
      case "CLOSED":
        verdicts.set(prUrl, "closed")
        return "closed"
      case "OPEN":
        return "open"
      default:
        return null
    }
  }
}

async function runNew(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      branch: { type: "string" },
      root: { type: "string" },
      "no-setup": { type: "boolean" },
      json: { type: "boolean" },
    },
  })

  const slug = positionals[0]
  if (!slug) {
    process.stderr.write(
      "agentproto worktree new: missing slug.\n" +
        "  Try: agentproto worktree new <slug> [--repo <dir>] [--base <ref>] [--branch <name>]\n",
    )
    return 2
  }

  const repoRoot = repoRootOf(resolve(values.repo ?? process.cwd()))
  if (!repoRoot) {
    process.stderr.write("agentproto worktree new: not inside a git repository.\n")
    return 2
  }

  const root = await resolveWorktreesRoot(values.root)
  const dir = join(root, repoLabel(repoRoot), slug)

  try {
    const provisioned = await runTool({
      tool: provisionWorktreeTool,
      candidates,
      input: {
        repoRoot,
        slug,
        dir,
        ...(values.branch !== undefined ? { branch: values.branch } : {}),
        ...(values.base !== undefined ? { base: values.base } : {}),
        ...(values["no-setup"] ? { runSetup: false } : {}),
      },
    })

    if (values.json) {
      process.stdout.write(JSON.stringify(provisioned, null, 2) + "\n")
    } else {
      process.stdout.write(`worktree created  ${provisioned.cwd}  (branch ${provisioned.branch})\n`)
    }
    return 0
  } catch (err) {
    process.stderr.write(`agentproto worktree new: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

// ── shared: resolve a <path|slug> positional to (repoRoot, cwd, branch) ────────

interface ResolvedWorktreeTarget {
  repoRoot: string
  cwd: string
  /** `undefined` for a detached HEAD (git reports "HEAD" for `--abbrev-ref`). */
  branch: string | undefined
}

/** The branch a worktree at `cwd` is on, or `undefined` for a detached HEAD
 * (git reports "HEAD" for `--abbrev-ref`), so cleanup knows what to delete. */
function worktreeBranch(cwd: string): string | undefined {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" })
  const raw = res.status === 0 ? res.stdout.trim() : undefined
  return raw && raw !== "HEAD" ? raw : undefined
}

type SlugLookup =
  | { kind: "found"; repoRoot: string; cwd: string }
  | { kind: "ambiguous"; matches: string[] }
  | { kind: "none"; searched: string[] }

/**
 * Resolve a worktree *slug* (`model-catalog-3axis`) — or its branch spelling
 * (`wt/model-catalog-3axis`, as `ls` displays it) — to its on-disk worktree,
 * independent of cwd. `worktree new` lays every worktree it creates down at
 * `<worktrees.root>/<repoLabel>/<slug>` (dir named for the slug, branch
 * `wt/<slug>`); scanning that root is how `rm <slug>` resolves the owning repo
 * from a cwd *outside* it — which plain `resolve(<slug>)` (→ `<cwd>/<slug>`,
 * not a git dir) never could. Honors the same `worktrees.root` precedence as
 * `new` (env `AGENTPROTO_WORKTREES_ROOT` > config.json > default).
 */
async function lookupWorktreeSlug(slug: string, repoFlag: string | undefined): Promise<SlugLookup> {
  const bare = slug.replace(/^wt\//, "")
  const root = await resolveWorktreesRoot(undefined)

  // --repo pins the owning repo, so only its label bucket can hold the slug.
  // Otherwise scan every <root>/<repoLabel>/ bucket for a matching child.
  let buckets: string[]
  if (repoFlag) {
    const pinned = repoRootOf(resolve(repoFlag))
    buckets = pinned ? [repoLabel(pinned)] : []
  } else {
    try {
      buckets = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      buckets = []
    }
  }

  const searched: string[] = []
  const found: { repoRoot: string; cwd: string }[] = []
  for (const bucket of buckets) {
    const cwd = join(root, bucket, bare)
    searched.push(cwd)
    if (!existsSync(cwd)) continue
    const repoRoot = repoRootOf(cwd)
    if (repoRoot) found.push({ repoRoot, cwd })
  }

  if (found.length === 1) {
    const only = found[0]!
    return { kind: "found", repoRoot: only.repoRoot, cwd: only.cwd }
  }
  if (found.length > 1) return { kind: "ambiguous", matches: found.map((f) => f.cwd) }
  return { kind: "none", searched }
}

/** Resolves the shared `<path|slug> [--repo <dir>]` positional both `rm` and `archive` take. Writes its own error and returns `null` on failure. */
async function resolveWorktreeTarget(
  target: string | undefined,
  repoFlag: string | undefined,
  cmdName: string,
): Promise<ResolvedWorktreeTarget | null> {
  if (!target) {
    process.stderr.write(
      `agentproto worktree ${cmdName}: missing worktree path.\n` +
        `  Try: agentproto worktree ${cmdName} <path|slug>  (see \`agentproto worktree ls\`)\n`,
    )
    return null
  }

  // 1. An explicit path that exists on disk — `rm <abs>` / `rm ./rel` run from
  //    anywhere, and `rm <slug>` when cwd already sits at the slug's parent.
  //    Derive the owning MAIN repo from --repo, else the path's own git dir.
  const asPath = resolve(target)
  if (existsSync(asPath)) {
    const repoRoot = repoRootOf(resolve(repoFlag ?? asPath))
    if (repoRoot) return { repoRoot, cwd: asPath, branch: worktreeBranch(asPath) }
  }

  // 2. Otherwise treat `target` as a worktree slug placed under `worktrees.root`
  //    — the same cwd-independent source `new` writes to and `ls` reflects —
  //    so `rm <slug>` / `rm wt/<slug>` resolves from a cwd outside the repo.
  const lookup = await lookupWorktreeSlug(target, repoFlag)
  if (lookup.kind === "found") {
    return { repoRoot: lookup.repoRoot, cwd: lookup.cwd, branch: worktreeBranch(lookup.cwd) }
  }
  if (lookup.kind === "ambiguous") {
    process.stderr.write(
      `agentproto worktree ${cmdName}: "${target}" matches worktrees under more than one repo:\n` +
        lookup.matches.map((m) => `    ${m}`).join("\n") +
        `\n  Pass the full path, or --repo <dir> to pick one.\n`,
    )
    return null
  }

  // 3. Neither a path nor a known slug — say where we looked and how to recover.
  const where =
    lookup.searched.length > 0
      ? `  Looked for a path at ${asPath}, and a worktree slug under:\n` +
        lookup.searched.map((s) => `    ${s}`).join("\n") +
        "\n"
      : `  Looked for a path at ${asPath} (no worktrees.root buckets to scan for a slug).\n`
  process.stderr.write(
    `agentproto worktree ${cmdName}: could not resolve the git repo for "${target}".\n` +
      where +
      `  Run from inside the repo, pass the worktree path, or use --repo <dir>.\n`,
  )
  return null
}

// ── rm ──────────────────────────────────────────────────────────────────

/** The guarded destructive verb: refuses a dirty tree unless the matching `--discard-*` flag authorizes it. */
async function runRm(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      "keep-branch": { type: "boolean" },
      "discard-untracked": { type: "boolean" },
      "discard-modified": { type: "boolean" },
      json: { type: "boolean" },
    },
  })

  const resolved = await resolveWorktreeTarget(positionals[0], values.repo, "rm")
  if (!resolved) return 2
  const { repoRoot, cwd, branch } = resolved

  try {
    await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: {
        repoRoot,
        cwd,
        ...(branch ? { branch } : {}),
        deleteBranch: !values["keep-branch"],
        discardUntracked: Boolean(values["discard-untracked"]),
        discardModified: Boolean(values["discard-modified"]),
        ...(values.base !== undefined ? { base: values.base } : {}),
      },
    })
  } catch (err) {
    if (err instanceof WorktreeNotRemovableError) {
      process.stderr.write(`agentproto worktree rm: ${err.message}\n`)
      return 1
    }
    process.stderr.write(`agentproto worktree rm: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify({ removed: cwd, branch: branch ?? null }, null, 2) + "\n")
  } else {
    process.stdout.write(`worktree removed  ${cwd}${branch ? `  (branch ${branch})` : ""}\n`)
  }
  return 0
}

// ── archive ─────────────────────────────────────────────────────────────

/** Salvage-then-remove (PLAN.md §5.2 layer 4): snapshot uncommitted state, then remove with both discard flags granted. */
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

  const resolved = await resolveWorktreeTarget(positionals[0], values.repo, "archive")
  if (!resolved) return 2
  const { repoRoot, cwd, branch } = resolved

  const tipRes = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" })
  if (tipRes.status !== 0) {
    process.stderr.write(`agentproto worktree archive: could not resolve HEAD for "${cwd}".\n`)
    return 2
  }
  const tipSha = tipRes.stdout.trim()

  let salvageDir: string
  try {
    const result = await salvageWorktree({
      repoRoot,
      repoName: repoLabel(repoRoot),
      worktreePath: cwd,
      branch: branch ?? null,
      tipSha,
      slug: branch ?? basename(cwd),
    })
    salvageDir = result.dir
  } catch (err) {
    process.stderr.write(
      `agentproto worktree archive: salvage failed, nothing removed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  try {
    await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: {
        repoRoot,
        cwd,
        ...(branch ? { branch } : {}),
        deleteBranch: !values["keep-branch"],
        discardUntracked: true,
        discardModified: true,
        ...(values.base !== undefined ? { base: values.base } : {}),
      },
    })
  } catch (err) {
    process.stderr.write(
      `agentproto worktree archive: salvaged to ${salvageDir}, but removal failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify({ archived: cwd, branch: branch ?? null, salvageDir }, null, 2) + "\n")
  } else {
    process.stdout.write(`worktree archived  ${cwd}${branch ? `  (branch ${branch})` : ""}  (salvaged to ${salvageDir})\n`)
  }
  return 0
}

// ── gc ──────────────────────────────────────────────────────────────────

/**
 * `gc` (PLAN.md §5, PR-D): dry-run by default, `--apply` executes. All the
 * safety logic lives in `@agentproto/worktree`'s `planGc`/`applyGc` — this
 * is a thin shell that resolves the repo, wires up the same forge/memo `ls
 * --status` uses, and renders the result.
 */
async function runGc(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      repo: { type: "string" },
      apply: { type: "boolean" },
      "salvage-dirty": { type: "boolean" },
      "include-detached": { type: "boolean" },
      json: { type: "boolean" },
    },
  })

  const repoRoot = repoRootOf(resolve(values.repo ?? process.cwd()))
  if (!repoRoot) {
    process.stderr.write("agentproto worktree gc: not inside a git repository.\n")
    return 2
  }

  const [forge, defaultBranch] = await Promise.all([createForgeClient(repoRoot), detectDefaultBranch(repoRoot)])
  const repoName = repoLabel(repoRoot)
  const memo = new FileVerdictMemoStore()
  const includeDetached = Boolean(values["include-detached"])
  const salvageDirty = Boolean(values["salvage-dirty"])
  const defaultBranchRef = `origin/${defaultBranch}`

  const plan = await planGc({ repoRoot, repoName, forge, memo, defaultBranchRef, includeDetached })

  if (!values.apply) {
    printGcPlan(plan, salvageDirty, Boolean(values.json))
    return 0
  }

  const outcomes = await applyGc(plan, {
    repoRoot,
    repoName,
    forge,
    memo,
    defaultBranchRef,
    includeDetached,
    salvageDirty,
  })
  printGcOutcomes(outcomes, Boolean(values.json))
  return outcomes.some((o) => o.result === "failed") ? 1 : 0
}

function printGcPlan(plan: readonly GcPlanEntry[], salvageDirty: boolean, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n")
    return
  }
  if (plan.length === 0) {
    process.stdout.write("No worktrees.\n")
    return
  }
  process.stdout.write(
    `${"BRANCH".padEnd(28)}  ${"CLASS".padEnd(9)}  ${"ACTION".padEnd(30)}  ${"TREE".padEnd(16)}  ${"INTEGRATION".padEnd(26)}  PATH\n`,
  )
  const counts = { reclaim: 0, salvage: 0, hold: 0 }
  for (const entry of plan) {
    counts[entry.class]++
    process.stdout.write(formatGcPlanRow(entry, salvageDirty) + "\n")
  }
  process.stdout.write(
    `\n${counts.reclaim} reclaim, ${counts.salvage} salvage, ${counts.hold} hold. ` +
      `Dry run — pass --apply to execute` +
      (counts.salvage > 0 && !salvageDirty ? " (add --salvage-dirty to also archive salvage-class worktrees)" : "") +
      ".\n",
  )
}

function gcPlanAction(entry: GcPlanEntry, salvageDirty: boolean): string {
  if (entry.class === "reclaim") return "reclaim (rm, delete branch)"
  if (entry.class === "salvage") return salvageDirty ? "salvage (archive)" : "salvage (skip: needs --salvage-dirty)"
  return "hold (never touched)"
}

function formatGcPlanRow(entry: GcPlanEntry, salvageDirty: boolean): string {
  const branch = entry.branch ?? "(detached)"
  return [
    branch.padEnd(28),
    entry.class.padEnd(9),
    gcPlanAction(entry, salvageDirty).padEnd(30),
    formatTree(entry.tree).padEnd(16),
    formatIntegration(entry.integration).padEnd(26),
    entry.path,
  ].join("  ")
}

function formatGcOutcomeRow(outcome: GcApplyOutcome): string {
  const branch = outcome.branch ?? "(detached)"
  let detail: string
  switch (outcome.result) {
    case "reclaimed":
      detail = "reclaimed"
      break
    case "salvaged":
      detail = `salvaged (${outcome.salvageDir})`
      break
    case "held":
      detail = "held"
      break
    case "skipped-dirty":
      detail = "skipped (needs --salvage-dirty)"
      break
    case "aborted-reclassified":
      detail = `aborted: reclassified ${outcome.from} → ${outcome.to} since the plan was made`
      break
    case "aborted-vanished":
      detail = "aborted: worktree no longer exists"
      break
    case "failed":
      detail = `failed: ${outcome.message}`
      break
  }
  return `${branch.padEnd(28)}  ${detail}  ${outcome.path}`
}

function printGcOutcomes(outcomes: readonly GcApplyOutcome[], json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(outcomes, null, 2) + "\n")
    return
  }
  if (outcomes.length === 0) {
    process.stdout.write("No worktrees.\n")
    return
  }
  for (const outcome of outcomes) process.stdout.write(formatGcOutcomeRow(outcome) + "\n")
  const reclaimed = outcomes.filter((o) => o.result === "reclaimed").length
  const salvaged = outcomes.filter((o) => o.result === "salvaged").length
  const failed = outcomes.filter((o) => o.result === "failed").length
  process.stdout.write(`\n${reclaimed} reclaimed, ${salvaged} salvaged, ${failed} failed.\n`)
}
