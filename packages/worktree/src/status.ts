/**
 * The status engine (PLAN.md §1–§1.5): a worktree's status is derived at
 * read time from three orthogonal axes — `tree`, `integration`, `liveness`
 * — plus a `provenance` field that never affects classification. Nothing
 * here is a registry: every value is recomputed from git, the forge, and
 * the sessions snapshot on every call (PLAN.md §1.4's no-registry
 * principle). The one piece of durable state, the verdict memo
 * (`~/.agentproto/worktree-verdicts.json`), is a memo of *immutable* facts
 * only (a merged PR stays merged) — deleting it changes nothing but speed
 * and offline honesty, the acid test a real registry fails.
 *
 * The reconciliation rule (`reconcileIntegration`, PLAN.md §1.3) is the
 * heart of this module: it is why ad-hoc shell answers to "how many
 * worktrees are stale?" went 5 → 22 → 21+8 in one session, and why this is
 * code with tests instead. Every step is a pure function of `(T,
 * origin/main, the forge's merged-PR records)` — content-addressed inputs,
 * so two runs at the same repo state produce byte-identical answers.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import { z } from "zod"
import { execArgv, execGit } from "./exec.js"
import type { ForgeClient, ForgePullRequestRef } from "./forge.js"
import {
  computeProvenance,
  readSessionsRegistry,
  sessionInWorktree,
  SESSIONS_FILE_PATH,
  type ComputeProvenanceOptions,
  type ProvenanceInfo,
} from "./provenance.js"

// ── tree axis ─────────────────────────────────────────────────────────

export type TreeState =
  | { state: "clean" }
  | {
      state: "dirty"
      modified: number
      staged: number
      untracked: number
      /**
       * Newest mtime (epoch ms) among the worktree's own dirty paths
       * (unstaged, staged, and untracked), or `null` if it couldn't be
       * determined. Feeds `classify`'s `RECENT_WRITE_HOLD_WINDOW_MS` guard —
       * a liveness-independent "someone touched this a moment ago" signal.
       */
      newestMtimeMs: number | null
    }

/**
 * `git status --porcelain=v2` in the worktree itself, via `-C worktreePath`
 * (tree state is per-worktree, not `repoRoot`'s). The spawn's own `cwd`,
 * though, is `repoRoot` — the main checkout, which git itself refuses to
 * remove (`gc.ts`'s docblock) — NOT `worktreePath`: a linked worktree can be
 * removed by a concurrent `gc` reap while this call (or a racing caller
 * reading the same worktree, e.g. a status poll) is in flight, and a spawn
 * whose `cwd` no longer exists on disk fails `ENOENT` on the COMMAND itself
 * (a Node/libuv quirk, not "directory not found") — exactly the failure mode
 * `exec.ts`'s `execGit` already anchors against. Gitignored files never
 * appear here (no `--ignored` flag passed), matching git's own non-`--force`
 * `worktree remove` tolerance for them (PLAN.md §0.5) — the two notions of
 * "clean" agree by construction.
 */
export async function computeTreeState(repoRoot: string, worktreePath: string): Promise<TreeState> {
  const res = await execArgv("git", ["-C", worktreePath, "status", "--porcelain=v2"], repoRoot)
  if (res.exitCode !== 0) {
    throw new Error(
      `git status --porcelain=v2 failed in ${worktreePath} (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`,
    )
  }
  let modified = 0
  let staged = 0
  let untracked = 0
  for (const line of res.stdout.split("\n")) {
    if (!line) continue
    if (line.startsWith("? ")) {
      untracked++
      continue
    }
    if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const xy = line.split(" ", 2)[1] ?? ".."
      if (xy[0] !== ".") staged++
      if (xy[1] !== ".") modified++
    }
  }
  if (modified === 0 && staged === 0 && untracked === 0) return { state: "clean" }
  return {
    state: "dirty",
    modified,
    staged,
    untracked,
    newestMtimeMs: await newestDirtyMtimeMs(repoRoot, worktreePath),
  }
}

/**
 * Newest on-disk mtime among unstaged, staged, and untracked paths, read via
 * three plain plumbing commands (`-z`-delimited, so odd filenames can't
 * confuse the split) rather than by parsing `status --porcelain=v2`'s mixed
 * ordinary/rename record shapes. A path that stats out from under us
 * (removed/renamed between the status read and this call) is skipped, not
 * fatal — this is a best-effort recency signal, not a source of truth. Spawn
 * `cwd` is `repoRoot`, not `worktreePath` — see `computeTreeState`'s doc.
 */
async function newestDirtyMtimeMs(repoRoot: string, worktreePath: string): Promise<number | null> {
  const [unstaged, staged, untracked] = await Promise.all([
    execArgv("git", ["-C", worktreePath, "diff", "--name-only", "-z"], repoRoot),
    execArgv("git", ["-C", worktreePath, "diff", "--cached", "--name-only", "-z"], repoRoot),
    execArgv("git", ["-C", worktreePath, "ls-files", "--others", "--exclude-standard", "-z"], repoRoot),
  ])
  const paths = new Set<string>()
  for (const res of [unstaged, staged, untracked]) {
    if (res.exitCode !== 0) continue
    for (const p of res.stdout.split("\0")) if (p) paths.add(p)
  }
  let newest: number | null = null
  for (const p of paths) {
    try {
      const st = await stat(resolve(worktreePath, p))
      if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs
    } catch {
      // deleted/renamed since the status read — not a live write, skip.
    }
  }
  return newest
}

// ── integration axis ─────────────────────────────────────────────────

const integrationBase = { checkedAt: z.string() }

const integrationStateSchema = z.union([
  z.object({ ...integrationBase, state: z.literal("fresh") }),
  z.object({
    ...integrationBase,
    state: z.literal("merged"),
    via: z.literal("squash"),
    pr: z.number(),
    offline: z.boolean(),
  }),
  z.object({
    ...integrationBase,
    state: z.literal("partial"),
    pr: z.number(),
    aheadBy: z.number(),
    offline: z.boolean(),
  }),
  z.object({ ...integrationBase, state: z.literal("open"), pr: z.number(), offline: z.boolean() }),
  z.object({ ...integrationBase, state: z.literal("pushed-no-pr") }),
  z.object({ ...integrationBase, state: z.literal("unpushed"), aheadBy: z.number() }),
  z.object({ ...integrationBase, state: z.literal("local-only") }),
  z.object({ ...integrationBase, state: z.literal("gone-unexplained") }),
  z.object({ ...integrationBase, state: z.literal("diverged"), offline: z.boolean() }),
  z.object({ ...integrationBase, state: z.literal("detached") }),
  z.object({ ...integrationBase, state: z.literal("unknown"), reason: z.literal("offline") }),
])

/** PLAN.md §1.2's `integration` axis, in full — every state the rule can produce. */
export type IntegrationState = z.infer<typeof integrationStateSchema>

// ── verdict memo (PLAN.md §1.4) ─────────────────────────────────────────

const verdictMemoRecordSchema = z.object({
  repo: z.string(),
  branch: z.string(),
  tipSha: z.string(),
  verdict: integrationStateSchema,
  checkedAt: z.string(),
})
export type VerdictMemoRecord = z.infer<typeof verdictMemoRecordSchema>

const verdictMemoFileSchema = z.object({ entries: z.array(verdictMemoRecordSchema) })

export const VERDICT_MEMO_PATH = (): string => resolve(homedir(), ".agentproto", "worktree-verdicts.json")

/**
 * NUL joins the parts because it cannot occur in a repo name, a git ref, or a
 * sha — so the key needs no escaping to stay unambiguous. It is written as the
 * `\u0000` escape and must stay that way: a literal NUL byte in the source
 * makes this whole file read as binary to `grep` and `file`, which silently
 * returns no matches for it rather than erroring.
 */
function memoKey(repo: string, branch: string, tipSha: string): string {
  return `${repo}\u0000${branch}\u0000${tipSha}`
}

/** Only forge-derived verdicts are ever memoised (PLAN.md §1.4/§2) — local-only classifications need no cache. */
export interface VerdictMemoStore {
  get(repo: string, branch: string, tipSha: string): Promise<VerdictMemoRecord | null>
  set(record: VerdictMemoRecord): Promise<void>
}

/**
 * `~/.agentproto/worktree-verdicts.json` — entries keyed by `(repo, branch,
 * tipSha)`. This is NOT a third status authority (PLAN.md §1.4): every
 * entry memoises an immutable fact (a containment check between two fixed
 * SHAs has one eternal answer; a merged PR stays merged). Deleting the file
 * changes nothing but speed and offline honesty.
 */
export class FileVerdictMemoStore implements VerdictMemoStore {
  private cache: Map<string, VerdictMemoRecord> | null = null

  constructor(private readonly path: string = VERDICT_MEMO_PATH()) {}

  private async load(): Promise<Map<string, VerdictMemoRecord>> {
    if (this.cache) return this.cache
    const map = new Map<string, VerdictMemoRecord>()
    this.cache = map
    let raw: string
    try {
      raw = await readFile(this.path, "utf8")
    } catch {
      return map
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return map
    }
    const result = verdictMemoFileSchema.safeParse(parsed)
    if (!result.success) return map
    for (const entry of result.data.entries) map.set(memoKey(entry.repo, entry.branch, entry.tipSha), entry)
    return map
  }

  async get(repo: string, branch: string, tipSha: string): Promise<VerdictMemoRecord | null> {
    const map = await this.load()
    return map.get(memoKey(repo, branch, tipSha)) ?? null
  }

  async set(record: VerdictMemoRecord): Promise<void> {
    const map = await this.load()
    map.set(memoKey(record.repo, record.branch, record.tipSha), record)
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify({ entries: [...map.values()] }, null, 2) + "\n", "utf8")
  }
}

/** In-memory-only store — for tests, or callers that don't want a durable memo. */
export class InMemoryVerdictMemoStore implements VerdictMemoStore {
  private readonly map = new Map<string, VerdictMemoRecord>()
  async get(repo: string, branch: string, tipSha: string): Promise<VerdictMemoRecord | null> {
    return this.map.get(memoKey(repo, branch, tipSha)) ?? null
  }
  async set(record: VerdictMemoRecord): Promise<void> {
    this.map.set(memoKey(record.repo, record.branch, record.tipSha), record)
  }
}

// ── local git read helpers ──────────────────────────────────────────────

/**
 * `git merge-base --is-ancestor A B`: exit 0 = true, exit 1 = false, any
 * other exit is a real git error (e.g. `B` isn't a known local ref).
 * Resilient callers (the rule's own step 1) treat that as "not an
 * ancestor" rather than crash a whole sweep over one worktree.
 */
async function isAncestor(repoRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  const res = await execArgv(
    "git",
    ["-C", repoRoot, "merge-base", "--is-ancestor", ancestor, descendant],
    repoRoot,
  )
  if (res.exitCode === 0) return true
  if (res.exitCode === 1) return false
  throw new Error(
    `git merge-base --is-ancestor ${ancestor} ${descendant} failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
  )
}

async function revListCount(repoRoot: string, range: string): Promise<number> {
  const res = await execGit(repoRoot, ["rev-list", "--count", range])
  return Number.parseInt(res.stdout.trim(), 10)
}

interface UpstreamInfo {
  upstream: string | null
  gone: boolean
  aheadBy: number
}

/** `for-each-ref '%(upstream)' '%(upstream:track)'` for one branch (PLAN.md §1.3 step 4). */
async function readUpstreamTrack(repoRoot: string, branch: string): Promise<UpstreamInfo> {
  const res = await execArgv(
    "git",
    ["-C", repoRoot, "for-each-ref", "--format=%(upstream)%09%(upstream:track)", `refs/heads/${branch}`],
    repoRoot,
  )
  if (res.exitCode !== 0) return { upstream: null, gone: false, aheadBy: 0 }
  const [rawUpstream, rawTrack] = res.stdout.split("\t")
  const upstream = (rawUpstream ?? "").trim()
  if (!upstream) return { upstream: null, gone: false, aheadBy: 0 }
  const track = (rawTrack ?? "").trim()
  const aheadMatch = track.match(/ahead (\d+)/)
  return {
    upstream,
    gone: track.includes("[gone]"),
    aheadBy: aheadMatch ? Number.parseInt(aheadMatch[1] ?? "0", 10) : 0,
  }
}

export interface GitWorktreeRef {
  path: string
  /** `null` for a detached HEAD. */
  branch: string | null
  head: string
}

/** Parses `git worktree list --porcelain` — every linked worktree of `repoRoot`, wherever it lives. */
export async function listGitWorktrees(repoRoot: string): Promise<GitWorktreeRef[]> {
  const res = await execGit(repoRoot, ["worktree", "list", "--porcelain"])
  const entries: GitWorktreeRef[] = []
  let current: { path: string; branch: string | null; head: string } | null = null
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current)
      current = { path: line.slice("worktree ".length), branch: null, head: "" }
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length)
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
    } else if (current && line === "detached") {
      current.branch = null
    }
  }
  if (current) entries.push(current)
  return entries
}

// ── the reconciliation rule (PLAN.md §1.3) ──────────────────────────────

export interface ReconcileIntegrationInput {
  repoRoot: string
  repoName: string
  /** `null` for a detached HEAD — short-circuits to `{ state: "detached" }` (step 0). */
  branch: string | null
  tipSha: string
  forge: ForgeClient
  memo: VerdictMemoStore
  /** Default `"origin/main"` — matches `loadConfigFromBase`'s own default. */
  defaultBranchRef?: string
  /** Injectable clock so callers (the determinism test) can freeze `checkedAt`. */
  now?: () => string
}

function newestMergedFirst(prs: readonly ForgePullRequestRef[]): ForgePullRequestRef[] {
  return prs
    .filter((pr) => pr.merged)
    .slice()
    .sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""))
}

function dedupeByNumber(prs: readonly ForgePullRequestRef[]): ForgePullRequestRef[] {
  const byNumber = new Map<number, ForgePullRequestRef>()
  for (const pr of prs) byNumber.set(pr.number, pr)
  return [...byNumber.values()]
}

/**
 * PLAN.md §1.3 — the heart of the design. Implements the six-step rule
 * exactly: local ancestry first (cheap, no forge), then the forge's
 * merged-PR containment check (the squash-proof signal), then open PRs,
 * then local upstream tracking, with the verdict memo as the only fallback
 * when the forge is unreachable. Never guesses (step 5): a memo miss while
 * offline is `unknown(offline)`, full stop.
 */
export async function reconcileIntegration(input: ReconcileIntegrationInput): Promise<IntegrationState> {
  const now = input.now ?? (() => new Date().toISOString())
  const defaultBranchRef = input.defaultBranchRef ?? "origin/main"

  // Step 0: detached HEAD.
  if (input.branch === null) {
    return { state: "detached", checkedAt: now() }
  }
  const branch = input.branch

  // Step 1: local ancestry against the default branch — no forge needed.
  //
  // This can ONLY prove "every commit tipSha can reach is also on
  // defaultBranchRef" — it cannot tell WHY. That's `fresh`, not `merged`:
  // a branch created straight off main with zero commits of its own reaches
  // this exact same true (`worktree new` produces exactly that branch), and
  // — because a fast-forward merge moves the ref with no new commit object —
  // a branch that *did* have real commits, fast-forwarded into main, is
  // git-graph-identical to "always sat on main" afterward. There is no local
  // (or forge) signal that tells the two apart from here. `classify` still
  // lets a clean `fresh` worktree reclaim (nothing dirty ⇒ nothing to lose),
  // but it must never treat `fresh` as forge-confirmed enough to license
  // discarding uncommitted work — that ambiguity is exactly what destroyed a
  // live worktree via `gc --apply --salvage-dirty` on 2026-07-15.
  const ancestryOk = await isAncestor(input.repoRoot, input.tipSha, defaultBranchRef).catch(() => false)
  if (ancestryOk) {
    return { state: "fresh", checkedAt: now() }
  }

  // Steps 2/3: forge lookup. Any failure here means "forge unreachable" — step 5.
  let candidatePrs: ForgePullRequestRef[]
  try {
    const [byBranch, byCommit] = await Promise.all([
      input.forge.pullRequestsForBranch(branch),
      input.forge.pullRequestsForCommit(input.tipSha),
    ])
    candidatePrs = dedupeByNumber([...byBranch, ...byCommit])
  } catch {
    return reconcileOffline(input, now())
  }

  let verdict: IntegrationState | null
  try {
    verdict = await classifyAgainstPulls(input.repoRoot, input.tipSha, candidatePrs, now, input.forge)
  } catch {
    // A fetch of a PR's head, or a local git op mid-step-2, failed — treat as unreachable.
    return reconcileOffline(input, now())
  }
  if (verdict) {
    // Only forge-derived verdicts are memoised (PLAN.md §1.4/§2). A memo-write
    // failure is a cache miss next time, not a reason to downgrade this
    // already-fresh answer to offline.
    await input.memo.set({ repo: input.repoName, branch, tipSha: input.tipSha, verdict, checkedAt: verdict.checkedAt }).catch(() => {})
    return verdict
  }

  // Step 4: no PR at all — local upstream tracking, no forge needed.
  const upstream = await readUpstreamTrack(input.repoRoot, branch)
  if (upstream.upstream === null) return { state: "local-only", checkedAt: now() }
  if (upstream.gone) return { state: "gone-unexplained", checkedAt: now() }
  if (upstream.aheadBy > 0) return { state: "unpushed", aheadBy: upstream.aheadBy, checkedAt: now() }
  return { state: "pushed-no-pr", checkedAt: now() }
}

/**
 * Steps 2/3 proper: walk merged PRs newest-first for containment, then fall
 * back to "any open PR". Returns `null` when neither applies (the caller
 * proceeds to step 4's local upstream check) — distinct from throwing, which
 * means "the forge/local git op itself failed" (step 5).
 */
async function classifyAgainstPulls(
  repoRoot: string,
  tipSha: string,
  candidatePrs: readonly ForgePullRequestRef[],
  now: () => string,
  forge: ForgeClient,
): Promise<IntegrationState | null> {
  for (const pr of newestMergedFirst(candidatePrs)) {
    const H = pr.headRefOid
    await forge.ensurePullHeadFetched(pr.number, H)
    if (await isAncestor(repoRoot, tipSha, H)) {
      return { state: "merged", via: "squash", pr: pr.number, checkedAt: now(), offline: false }
    }
    if (await isAncestor(repoRoot, H, tipSha)) {
      const aheadBy = await revListCount(repoRoot, `${H}..${tipSha}`)
      return { state: "partial", pr: pr.number, aheadBy, checkedAt: now(), offline: false }
    }
    // Neither contains the other — try the next merged PR.
  }

  const [firstOpenPr] = candidatePrs.filter((pr) => pr.state === "open").sort((a, b) => a.number - b.number)
  if (firstOpenPr) {
    return { state: "open", pr: firstOpenPr.number, checkedAt: now(), offline: false }
  }

  // A merged PR was found by the forge but contained neither T nor was contained by it.
  if (newestMergedFirst(candidatePrs).length > 0) {
    return { state: "diverged", checkedAt: now(), offline: false }
  }
  return null
}

/** Step 5: forge unreachable — memo hit for the exact `(repo, branch, tipSha)`, else `unknown(offline)`. Never guess. */
async function reconcileOffline(input: ReconcileIntegrationInput, checkedAt: string): Promise<IntegrationState> {
  if (input.branch === null) return { state: "detached", checkedAt }
  const cached = await input.memo.get(input.repoName, input.branch, input.tipSha)
  if (cached) {
    return offlineCopy(cached.verdict, checkedAt)
  }
  return { state: "unknown", reason: "offline", checkedAt }
}

/** Re-stamp a memoised verdict as an offline read, at the current check time. */
function offlineCopy(verdict: IntegrationState, checkedAt: string): IntegrationState {
  if (verdict.state === "merged" && verdict.via === "squash") {
    return { ...verdict, checkedAt, offline: true }
  }
  if (verdict.state === "partial" || verdict.state === "open" || verdict.state === "diverged") {
    return { ...verdict, checkedAt, offline: true }
  }
  return verdict
}

// ── liveness axis ────────────────────────────────────────────────────

const LIVE_SESSION_STATUSES = new Set(["starting", "running"])

/** `services` is always empty in PR-A — service liveness needs the daemon's in-process `ServiceSupervisor` (out of scope, see below). */
export type LivenessState =
  | { state: "idle"; sessions: ProvenanceInfo["sessions"]; services: string[] }
  | { state: "sessions"; sessions: ProvenanceInfo["sessions"]; services: string[] }
  | { state: "daemon-unreachable"; sessions: ProvenanceInfo["sessions"]; services: string[] }

/**
 * Live sessions whose `cwd` is contained in this worktree, read off the
 * same persisted sessions snapshot as provenance (PLAN.md §1.5) — no
 * running daemon required, matching `worktree check`'s no-daemon posture
 * (PLAN.md §3.3). Service liveness needs the daemon's in-process
 * `ServiceSupervisor` and is out of scope here (`services` is always `[]`);
 * `daemon-unreachable` fires only when the sessions snapshot itself is
 * present but unreadable (corrupt/permission-denied), not merely absent —
 * "no daemon has ever run" is a legitimate empty registry, not an error.
 */
export async function computeLiveness(
  worktreePath: string,
  options: ComputeProvenanceOptions = {},
): Promise<LivenessState> {
  const registry = await readSessionsRegistry(options.sessionsPath ?? SESSIONS_FILE_PATH())
  if (registry === null) return { state: "daemon-unreachable", sessions: [], services: [] }
  const live = registry
    .filter((s) => sessionInWorktree(s, worktreePath))
    .filter((s) => LIVE_SESSION_STATUSES.has(s.status))
  if (live.length > 0) return { state: "sessions", sessions: live, services: [] }
  return { state: "idle", sessions: [], services: [] }
}

// ── gate (PR-F fills this in; PR-A always reports "none") ──────────────

export type GateState = { state: "none" }

// ── classification (PLAN.md §1.2) ───────────────────────────────────────

export type WorktreeClass = "reclaim" | "salvage" | "hold"

export interface Classification {
  reclaimable: boolean
  class: WorktreeClass
}

/**
 * How recently a worktree's own dirty paths must have been written for
 * `classify` to hold it regardless of what `liveness` says. Liveness is
 * read off the agentproto session registry (`computeLiveness`) — it only
 * sees a worker that registered as a session, so it goes blind the instant
 * a daemon restart zeroes the registry, or an agent isn't registered at
 * all. This window is a liveness-independent backstop for exactly that
 * blind spot: work written in the last 15 minutes is presumptively still
 * in flight no matter what the (possibly-stale) session registry reports.
 * 15 minutes is deliberately generous — it costs nothing but a delayed gc
 * pass, while the cost of guessing wrong the other way is a destroyed
 * worktree.
 */
export const RECENT_WRITE_HOLD_WINDOW_MS = 15 * 60 * 1000

/**
 * `reclaimable ⇔ tree=clean ∧ integration ∈ {merged, fresh} ∧ liveness ∈
 * {idle, daemon-unreachable}` (PLAN.md §1.2). `daemon-unreachable` is
 * allowed because the hard guarantee against losing work is git's own
 * non-`--force` removal refusal, not the liveness probe. `fresh` reclaims
 * when clean for the same reason: a clean tree has nothing uncommitted to
 * lose, so it doesn't matter that `fresh` can't distinguish "never had
 * commits" from "real commits, fast-forwarded into main" (see
 * `reconcileIntegration` step 1) — either way there's nothing at risk.
 *
 * Salvage is narrower than reclaim on purpose: only `merged` (always
 * forge-confirmed — see `reconcileIntegration`) ever licenses destroying
 * dirty, uncommitted work — `fresh` never does, clean or not, because the
 * ambiguity in what `fresh` can prove is exactly what destroyed a live
 * worktree via `gc --apply --salvage-dirty` on 2026-07-15: a branch with
 * zero commits of its own read as "merged" and its uncommitted work was
 * salvaged-then-removed out from under a running agent. A `merged ∧ dirty`
 * worktree written to inside `RECENT_WRITE_HOLD_WINDOW_MS` also holds
 * instead of salvaging — see that constant's doc. Everything else is
 * `hold`.
 */
export function classify(
  tree: TreeState,
  integration: IntegrationState,
  liveness: LivenessState,
  nowMs: number = Date.now(),
): Classification {
  const merged = integration.state === "merged"
  const fresh = integration.state === "fresh"
  const clean = tree.state === "clean"
  const idleOrUnreachable = liveness.state === "idle" || liveness.state === "daemon-unreachable"
  if ((merged || fresh) && clean && idleOrUnreachable) return { reclaimable: true, class: "reclaim" }
  if (merged && !clean) {
    const writtenRecently =
      tree.state === "dirty" &&
      typeof tree.newestMtimeMs === "number" &&
      nowMs - tree.newestMtimeMs < RECENT_WRITE_HOLD_WINDOW_MS
    if (writtenRecently) return { reclaimable: false, class: "hold" }
    return { reclaimable: false, class: "salvage" }
  }
  return { reclaimable: false, class: "hold" }
}

// ── orchestration ────────────────────────────────────────────────────

export interface WorktreeStatusEntry {
  path: string
  branch: string | null
  head: string
  tree: TreeState
  integration: IntegrationState
  liveness: LivenessState
  provenance: ProvenanceInfo
  gate: GateState
  reclaimable: boolean
  class: WorktreeClass
}

export interface ComputeWorktreeStatusInput {
  repoRoot: string
  repoName: string
  worktree: GitWorktreeRef
  forge: ForgeClient
  memo: VerdictMemoStore
  defaultBranchRef?: string
  sessionsPath?: string
  now?: () => string
  /**
   * Clock for `classify`'s `RECENT_WRITE_HOLD_WINDOW_MS` guard — deliberately
   * separate from `now`. `now` freezes `checkedAt` stamps for deterministic
   * tests and is often a fixed past instant; file mtimes are always real
   * wall-clock, so comparing them against a frozen-past `now` would make
   * every dirty fixture look like it was written in the future (a negative,
   * and therefore always-"recent", delta). Defaults to `Date.now()`.
   */
  nowMs?: number
}

/** Computes all three axes + provenance + classification for one worktree. */
export async function computeWorktreeStatus(input: ComputeWorktreeStatusInput): Promise<WorktreeStatusEntry> {
  const [tree, integration, liveness, provenance] = await Promise.all([
    computeTreeState(input.repoRoot, input.worktree.path),
    reconcileIntegration({
      repoRoot: input.repoRoot,
      repoName: input.repoName,
      branch: input.worktree.branch,
      tipSha: input.worktree.head,
      forge: input.forge,
      memo: input.memo,
      defaultBranchRef: input.defaultBranchRef,
      now: input.now,
    }),
    computeLiveness(input.worktree.path, { sessionsPath: input.sessionsPath }),
    computeProvenance(input.repoRoot, input.worktree.path, { sessionsPath: input.sessionsPath }),
  ])
  const { reclaimable, class: cls } = classify(tree, integration, liveness, input.nowMs)
  return {
    path: input.worktree.path,
    branch: input.worktree.branch,
    head: input.worktree.head,
    tree,
    integration,
    liveness,
    provenance,
    gate: { state: "none" },
    reclaimable,
    class: cls,
  }
}

export interface ListWorktreeStatusesInput {
  repoRoot: string
  repoName: string
  forge: ForgeClient
  memo: VerdictMemoStore
  defaultBranchRef?: string
  sessionsPath?: string
  now?: () => string
}

/** Enumerates every linked worktree of `repoRoot` (`git worktree list`) and computes its status. */
export async function listWorktreeStatuses(input: ListWorktreeStatusesInput): Promise<WorktreeStatusEntry[]> {
  const worktrees = await listGitWorktrees(input.repoRoot)
  const results: WorktreeStatusEntry[] = []
  for (const worktree of worktrees) {
    results.push(
      await computeWorktreeStatus({
        repoRoot: input.repoRoot,
        repoName: input.repoName,
        worktree,
        forge: input.forge,
        memo: input.memo,
        defaultBranchRef: input.defaultBranchRef,
        sessionsPath: input.sessionsPath,
        now: input.now,
      }),
    )
  }
  return results
}
