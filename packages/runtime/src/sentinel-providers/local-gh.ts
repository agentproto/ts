/**
 * `local-gh` — the zero-infra sentinel provider (AIP-60 §5 first row).
 *
 * Poll-only: diffs successive {@link PrStatusSnapshot}s (the same
 * `fetchPrStatus` the `review_pr` tool already uses, over the host's
 * authenticated `gh` CLI) into `SentinelEvent`s. No push, no external
 * resource to create/cancel — watching IS polling.
 *
 * State threading through the generic runtime (`sentinel-runtime.ts`) only
 * round-trips `SentinelHandle.cursor` on every `poll()` call (`state` is set
 * once at `create()`/`attach()` and never touched again by the poll path —
 * see that module's `pollSentinel`). So the diffing baseline (the last
 * snapshot), the gh-failure backoff counter, and the last error all live
 * INSIDE the opaque `cursor` string as a small JSON blob — `handle.state`
 * only carries the immutable `{repo, number}` identity set at `create()`.
 * This is a deliberate reading of design §5's "cursor = last snapshot hash
 * in handle.state": since `poll()` cannot persist `state`, the actual
 * snapshot (not just a hash of it) has to travel through `cursor` instead.
 *
 * First poll always establishes the baseline with zero emitted events —
 * `diffSnapshots` only fires when there IS a previous snapshot to compare
 * against.
 *
 * A new `headSha` between two snapshots (a push) resets the check baseline
 * to empty and emits a `github.pull_request.synchronize` event — otherwise a
 * same-conclusion rerun on the new head (e.g. lint fails again) would mint
 * the same check event id as the old head's and get dropped by the delivery
 * dedup, and a check that finishes between two polls on the new head would
 * never fire at all (it'd already look "seen" against the old head's
 * by-name conclusions).
 *
 * REPO SCOPE. A sentinel whose single clause subject is a bare repo
 * (`github:owner/repo`, no `#n`) watches EVERY pull request of that repo, not
 * one: new PRs (`pull_request.opened`), draft -> ready
 * (`pull_request.ready_for_review`), CI verdicts (`check_suite.completed`, one
 * per head once the checks settle or the first failure), reviews, and
 * merge/close (`pull_request.closed`). One GraphQL call per repo per tick, so
 * the cost does not grow with the number of open PRs. It must use
 * `until: never` (a merged PR must not end the watch). The first poll only
 * records what exists - no events for pre-existing PRs.
 *
 * `github.issue_comment.created` (in `GITHUB_DEFAULT_PR_TYPES`) is NOT
 * produced here: it would need its own `issues/:n/comments` poll beyond what
 * `fetchPrStatus` already fetches, and isn't wired up yet. A sentinel
 * watching a PR for comments should add `webhook`/`agentpush` for that type,
 * or wait for this provider to grow it.
 */

import { createHash } from "node:crypto"
import { execGh, fetchPrStatus, prRef, type GhRunner } from "../review-pr.js"
import type { PrStatusSnapshot } from "../review-ledger.js"
import { GITHUB_DEFAULT_PR_TYPES } from "../sentinel-github-normalize.js"
import type {
  DeliveryPreference,
  SentinelEvent,
  SentinelHandle,
  SentinelProviderHandle,
  SentinelSpec,
} from "./types.js"

export const LOCAL_GH_SLUG = "local-gh"

const DEFAULT_BACKOFF_BASE_MS = 30_000
const DEFAULT_BACKOFF_CAP_MS = 300_000

// ── Identity (handle.state — set once, never touched by poll()) ─────────

interface LocalGhIdentity {
  repo: string
  /** Absent for a repo-scope watch. */
  number?: number
}

const GITHUB_PR_SUBJECT_RE = /^github:([^/]+\/[^#]+)#(\d+)$/

function parsePrSubject(subject: string): LocalGhIdentity | undefined {
  const m = GITHUB_PR_SUBJECT_RE.exec(subject)
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined
}

function parseIdentity(state: Record<string, unknown> | undefined): LocalGhIdentity | undefined {
  const repo = state?.repo
  const number = state?.number
  if (typeof repo !== "string") return undefined
  return typeof number === "number" ? { repo, number } : { repo }
}

const GITHUB_REPO_SUBJECT_RE = /^github:([^/#]+\/[^/#]+)$/

function parseRepoSubject(subject: string): string | undefined {
  return GITHUB_REPO_SUBJECT_RE.exec(subject)?.[1]
}

/** The types a repo-scope watch delivers by default: no per-push
 *  `synchronize` and no comments - the brain wants verdicts, not chatter. */
export const GITHUB_REPO_DEFAULT_TYPES: readonly string[] = [
  "github.pull_request.opened",
  "github.pull_request.ready_for_review",
  "github.check_suite.completed",
  "github.pull_request_review.submitted",
  "github.pull_request.closed",
]

const REPO_PRS_CAP = 200

// ── Cursor blob (mutable poll state — see module doc) ────────────────────

interface RepoPrState {
  snapshot: PrStatusSnapshot
  draft: boolean
  closedEmitted: boolean
  /** `<headSha>:<verdict>` of the last CI verdict reported for this PR. */
  ciReported?: string
}

interface LocalGhCursorState {
  /** Repo scope only: every known PR of the repo, by number. Absent until the
   *  first (baseline) poll has run. */
  repoPrs?: Record<string, RepoPrState>
  /** Repo scope: ISO time of the baseline poll; PRs created before it are
   *  history, never "opened" news. */
  baselinedAt?: string
  snapshot?: PrStatusSnapshot
  consecutiveFailures: number
  /** A terminal `pull_request.closed` event has been emitted for the current
   *  closed episode. Reset when the PR is seen open again. Absent on cursors
   *  written before this field existed, which is what lets the poll heal a
   *  sentinel that baselined an already-closed PR and so never fired. */
  closedEmitted?: boolean
  lastError?: string
  /** ms epoch; `poll()` skips calling `gh` at all until this passes
   *  (design §5: "Backoff on gh errors/rate limit, surfaced via status()"). */
  nextRetryAtMs?: number
}

function parseCursorState(cursor: string | undefined): LocalGhCursorState {
  if (!cursor) return { consecutiveFailures: 0 }
  try {
    const parsed = JSON.parse(cursor) as Partial<LocalGhCursorState>
    return {
      consecutiveFailures: typeof parsed.consecutiveFailures === "number" ? parsed.consecutiveFailures : 0,
      ...(parsed.snapshot ? { snapshot: parsed.snapshot } : {}),
      ...(parsed.repoPrs ? { repoPrs: parsed.repoPrs } : {}),
      ...(parsed.baselinedAt ? { baselinedAt: parsed.baselinedAt } : {}),
      ...(parsed.closedEmitted !== undefined ? { closedEmitted: parsed.closedEmitted } : {}),
      ...(parsed.lastError ? { lastError: parsed.lastError } : {}),
      ...(parsed.nextRetryAtMs !== undefined ? { nextRetryAtMs: parsed.nextRetryAtMs } : {}),
    }
  } catch {
    return { consecutiveFailures: 0 }
  }
}

function serializeCursorState(state: LocalGhCursorState): string {
  return JSON.stringify(state)
}

// ── Diffing (design §5: state change, new reviews, checks newly complete) ──

function subjectsForPr(repo: string, number: number): string[] {
  const owner = repo.split("/")[0] ?? repo
  return [`github:${repo}#${number}`, `github:${repo}`, `github:${owner}`]
}

function mintLocalGhEventId(parts: readonly string[]): string {
  return `evt_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`
}

/** Worst-of rollup for a set of check-run conclusions completing in the same
 *  tick, grouped into one `check_suite.completed` event (design §5: "grouped
 *  per tick"). */
function rollupConclusion(conclusions: readonly (string | null)[]): string {
  if (conclusions.some(c => c === "failure" || c === "timed_out" || c === "cancelled" || c === "action_required")) {
    return "failure"
  }
  if (conclusions.every(c => c === "success" || c === "skipped" || c === "neutral")) return "success"
  return "neutral"
}

function makeEvent(input: {
  idParts: readonly string[]
  type: string
  subject: string
  subjects: readonly string[]
  terminal: boolean
  time: string
  data: Record<string, unknown>
  summary: string
}): SentinelEvent {
  return {
    specversion: "1.0",
    id: mintLocalGhEventId(input.idParts),
    source: `//agentproto.local/sentinel/${LOCAL_GH_SLUG}`,
    type: input.type,
    subject: input.subject,
    time: input.time,
    datacontenttype: "application/json",
    data: input.data,
    summary: input.summary,
    subjects: input.subjects,
    terminal: input.terminal,
  }
}

function closedEvent(
  current: PrStatusSnapshot,
  ctx: { repo: string; number: number; subject: string },
  late: boolean,
): SentinelEvent {
  const prTag = `${ctx.repo}#${ctx.number}`
  const merged = current.state === "merged"
  return makeEvent({
    // `fetchedAt` (not just prTag+state) so a reopen-then-close within
    // one watch produces two distinct ids instead of deduping the second.
    idParts: [prTag, "closed", current.state, current.fetchedAt],
    type: "github.pull_request.closed",
    subject: ctx.subject,
    subjects: subjectsForPr(ctx.repo, ctx.number),
    terminal: true,
    time: current.fetchedAt,
    data: { action: "closed", merged, repo: ctx.repo, number: ctx.number, ...(late ? { late: true } : {}) },
    summary: merged ? `PR ${prTag} merged` : `PR ${prTag} closed`,
  })
}

/** `undefined` previous ⇒ this IS the baseline poll — no historical events. */
function diffSnapshots(
  previous: PrStatusSnapshot | undefined,
  current: PrStatusSnapshot,
  ctx: { repo: string; number: number; subject: string },
): SentinelEvent[] {
  if (!previous) return []
  const events: SentinelEvent[] = []
  const subjects = subjectsForPr(ctx.repo, ctx.number)
  const prTag = `${ctx.repo}#${ctx.number}`

  if (previous.state !== current.state && current.state !== "open") {
    events.push(closedEvent(current, ctx, false))
  }

  // GitHub's reviews endpoint returns the full, append-only history — a
  // "new" review is everything past what the previous snapshot already saw.
  const newReviews = current.reviews.slice(previous.reviews.length)
  for (const review of newReviews) {
    events.push(
      makeEvent({
        idParts: [prTag, "review", review.login, review.state, review.submittedAt],
        type: "github.pull_request_review.submitted",
        subject: ctx.subject,
        subjects,
        terminal: false,
        time: current.fetchedAt,
        data: { action: "submitted", state: review.state, repo: ctx.repo, number: ctx.number, actor: review.login },
        summary: `PR ${prTag} review ${review.state} by ${review.login}`,
      }),
    )
  }

  // A new head sha means every check on `previous` belongs to a commit
  // that's gone — diff checks against an empty baseline so a same-conclusion
  // rerun (e.g. lint fails again) still fires, and surface the push itself
  // as a non-terminal event so a caller watching only for "PR moved" sees it
  // even when no check finishes between polls.
  const headChanged =
    previous.headSha !== undefined && current.headSha !== undefined && previous.headSha !== current.headSha
  const checksBaseline = headChanged ? [] : (previous.checks ?? [])

  if (headChanged) {
    const shortSha = current.headSha!.slice(0, 7)
    events.push(
      makeEvent({
        idParts: [prTag, "synchronize", current.headSha!],
        type: "github.pull_request.synchronize",
        subject: ctx.subject,
        subjects,
        terminal: false,
        time: current.fetchedAt,
        data: { action: "synchronize", repo: ctx.repo, number: ctx.number, headSha: current.headSha },
        summary: `New commits pushed to ${prTag} (${shortSha})`,
      }),
    )
  }

  const prevChecks = new Map(checksBaseline.map(c => [c.name, c.conclusion]))
  const nowCompleted = (current.checks ?? []).filter(
    c => c.conclusion !== null && (prevChecks.get(c.name) ?? null) === null,
  )
  if (nowCompleted.length > 0) {
    const conclusion = rollupConclusion(nowCompleted.map(c => c.conclusion))
    const namesKey = nowCompleted
      .map(c => `${c.name}:${c.conclusion ?? ""}`)
      .sort()
      .join(",")
    events.push(
      makeEvent({
        // headSha so an identical conclusion set on a new head (e.g. lint
        // fails again after a push) mints a fresh id instead of colliding
        // with the previous head's already-delivered event.
        idParts: [prTag, "checks", current.headSha ?? "", namesKey],
        type: "github.check_suite.completed",
        subject: ctx.subject,
        subjects,
        terminal: false,
        time: current.fetchedAt,
        data: { action: "completed", conclusion, repo: ctx.repo, number: ctx.number, checks: nowCompleted },
        summary: `Check suite ${conclusion} for ${prTag}`,
      }),
    )
  }

  return events
}


// ── Repo scope (one GraphQL call per repo per tick) ─────────────────────

const REPO_PRS_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(first:30,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url isDraft state createdAt headRefOid author{login} reviews(last:50){nodes{author{login} state submittedAt}} commits(last:1){nodes{commit{statusCheckRollup{contexts(first:60){nodes{__typename ... on CheckRun{name conclusion status} ... on StatusContext{context state}}}}}}}}}}}`

interface RepoPr {
  number: number
  title: string
  url: string
  author: string
  draft: boolean
  createdAt: string
  snapshot: PrStatusSnapshot
}

interface GqlContext {
  __typename?: string
  name?: string
  conclusion?: string | null
  status?: string
  context?: string
  state?: string
}

interface GqlPr {
  number: number
  title?: string
  url?: string
  isDraft?: boolean
  state?: string
  createdAt?: string
  headRefOid?: string
  author?: { login?: string } | null
  reviews?: { nodes?: Array<{ author?: { login?: string } | null; state?: string; submittedAt?: string | null } | null> }
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { contexts?: { nodes?: Array<GqlContext | null> } } | null } } | null> }
}

function contextToCheck(c: GqlContext): { name: string; conclusion: string | null } {
  if (c.__typename === "StatusContext") {
    const state = (c.state ?? "").toUpperCase()
    return {
      name: c.context ?? "",
      conclusion: state === "SUCCESS" ? "success" : state === "FAILURE" || state === "ERROR" ? "failure" : null,
    }
  }
  const done = (c.status ?? "").toUpperCase() === "COMPLETED"
  return { name: c.name ?? "", conclusion: done && c.conclusion ? c.conclusion.toLowerCase() : null }
}

async function fetchRepoPrs(gh: GhRunner, repo: string, now: () => Date): Promise<RepoPr[]> {
  const [owner, name] = repo.split("/") as [string, string]
  const out = await gh(["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-f", `query=${REPO_PRS_QUERY}`])
  let parsed: { data?: { repository?: { pullRequests?: { nodes?: Array<GqlPr | null> } } | null } }
  try {
    parsed = JSON.parse(out)
  } catch {
    throw new Error(`gh api graphql for ${repo} returned non-JSON output`)
  }
  const nodes = parsed.data?.repository?.pullRequests?.nodes
  if (!Array.isArray(nodes)) throw new Error(`gh api graphql for ${repo} returned no pull requests`)
  const fetchedAt = now().toISOString()
  return nodes
    .filter((n): n is GqlPr => !!n && typeof n.number === "number")
    .map(n => {
      const contexts = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
      return {
        number: n.number,
        title: n.title ?? "",
        url: n.url ?? "",
        author: n.author?.login ?? "",
        draft: n.isDraft === true,
        createdAt: n.createdAt ?? "",
        snapshot: {
          fetchedAt,
          state: n.state === "MERGED" ? "merged" : n.state === "CLOSED" ? "closed" : "open",
          reviews: (n.reviews?.nodes ?? [])
            .filter(r => !!r && r.state !== "PENDING")
            .map(r => ({ login: r!.author?.login ?? "", state: r!.state ?? "", submittedAt: r!.submittedAt ?? "" })),
          checks: contexts.filter((c): c is GqlContext => !!c).map(contextToCheck),
          ...(n.headRefOid ? { headSha: n.headRefOid } : {}),
        },
      }
    })
}

/** `failure` as soon as one check fails (no need to wait for the rest),
 *  `pending` while any is still running, else the settled rollup. */
function ciVerdict(checks: PrStatusSnapshot["checks"]): "none" | "pending" | "success" | "failure" | "neutral" {
  if (!checks || checks.length === 0) return "none"
  const failing = checks.filter(c => rollupConclusion([c.conclusion]) === "failure")
  if (failing.length > 0) return "failure"
  if (checks.some(c => c.conclusion === null)) return "pending"
  return rollupConclusion(checks.map(c => c.conclusion)) === "success" ? "success" : "neutral"
}

function compactPrState(snapshot: PrStatusSnapshot, extra: Omit<RepoPrState, "snapshot">): RepoPrState {
  // A closed, already-reported PR keeps only its state: the cursor is
  // rewritten on every tick, so it must not carry dead PRs' reviews/checks.
  const slim: PrStatusSnapshot =
    snapshot.state !== "open" && extra.closedEmitted
      ? { fetchedAt: snapshot.fetchedAt, state: snapshot.state, reviews: [], checks: [] }
      : snapshot
  return { snapshot: slim, ...extra }
}

function decorate(events: SentinelEvent[], pr: RepoPr): SentinelEvent[] {
  const title = pr.title.length > 80 ? `${pr.title.slice(0, 77)}...` : pr.title
  return events.map(e => ({
    ...e,
    data: { ...e.data, title: pr.title, url: pr.url, author: pr.author, draft: pr.draft },
    summary: title ? `${e.summary} - ${title}` : e.summary,
  }))
}

function diffRepoPr(prev: RepoPrState, pr: RepoPr, repo: string): { events: SentinelEvent[]; next: RepoPrState } {
  const ctx = { repo, number: pr.number, subject: `github:${repo}#${pr.number}` }
  const prTag = `${repo}#${pr.number}`
  const subjects = subjectsForPr(repo, pr.number)
  const now = pr.snapshot
  const events: SentinelEvent[] = []

  // A closed, already-reported PR is stored without its reviews/checks (see
  // compactPrState), so diffing it would replay its whole history as news.
  // Nothing more to say until it is reopened - then it restarts from a fresh
  // baseline.
  if (prev.closedEmitted) {
    return now.state === "open"
      ? { events: [], next: compactPrState(now, { draft: pr.draft, closedEmitted: false }) }
      : { events: [], next: prev }
  }

  if (prev.draft && !pr.draft && now.state === "open") {
    events.push(
      makeEvent({
        idParts: [prTag, "ready", now.fetchedAt],
        type: "github.pull_request.ready_for_review",
        subject: ctx.subject,
        subjects,
        terminal: false,
        time: now.fetchedAt,
        data: { action: "ready_for_review", repo, number: pr.number },
        summary: `PR ${prTag} ready for review`,
      }),
    )
  }

  // Reviews and open->closed come from the per-PR diff; its per-tick check
  // grouping and push events are replaced by the repo-level verdict below.
  const diffed = diffSnapshots(prev.snapshot, now, ctx).filter(
    e => e.type !== "github.check_suite.completed" && e.type !== "github.pull_request.synchronize",
  )
  events.push(...diffed)

  let ciReported = prev.ciReported
  if (now.state === "open") {
    const verdict = ciVerdict(now.checks)
    const key = `${now.headSha ?? ""}:${verdict}`
    if ((verdict === "success" || verdict === "failure" || verdict === "neutral") && key !== ciReported) {
      const failed = (now.checks ?? []).filter(c => rollupConclusion([c.conclusion]) === "failure").map(c => c.name)
      events.push(
        makeEvent({
          idParts: [prTag, "ci", now.headSha ?? "", verdict],
          type: "github.check_suite.completed",
          subject: ctx.subject,
          subjects,
          terminal: false,
          time: now.fetchedAt,
          data: { action: "completed", conclusion: verdict, repo, number: pr.number, ...(failed.length ? { failed } : {}) },
          summary: `CI ${verdict} for ${prTag}`,
        }),
      )
      ciReported = key
    }
  }

  let closedEmitted: boolean = prev.closedEmitted
  if (now.state === "open") closedEmitted = false
  else if (events.some(e => e.terminal)) closedEmitted = true
  else if (!closedEmitted) {
    events.push(closedEvent(now, ctx, true))
    closedEmitted = true
  }

  return {
    events: decorate(events, pr),
    next: compactPrState(now, { draft: pr.draft, closedEmitted, ...(ciReported ? { ciReported } : {}) }),
  }
}

/** Baseline poll records every PR silently; later polls turn new PRs and
 *  every change of a known PR into events. */
function diffRepo(
  cursor: LocalGhCursorState,
  prs: readonly RepoPr[],
  repo: string,
  fetchedAt: string,
): { events: SentinelEvent[]; repoPrs: Record<string, RepoPrState>; baselinedAt: string } {
  const known = cursor.repoPrs
  const baselinedAt = cursor.baselinedAt ?? fetchedAt
  const next: Record<string, RepoPrState> = { ...(known ?? {}) }
  const events: SentinelEvent[] = []

  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const key = String(pr.number)
    const prev = known?.[key]
    if (!prev) {
      const closed = pr.snapshot.state !== "open"
      const verdict = ciVerdict(pr.snapshot.checks)
      const silent = !known || (pr.createdAt !== "" && pr.createdAt < baselinedAt)
      if (!silent) {
        const prTag = `${repo}#${pr.number}`
        const subject = `github:${repo}#${pr.number}`
        const fresh: SentinelEvent[] = [
          makeEvent({
            idParts: [prTag, "opened"],
            type: "github.pull_request.opened",
            subject,
            subjects: subjectsForPr(repo, pr.number),
            terminal: false,
            time: pr.snapshot.fetchedAt,
            data: { action: "opened", repo, number: pr.number },
            summary: `PR ${prTag} opened${pr.author ? ` by ${pr.author}` : ""}${pr.draft ? " (draft)" : ""}`,
          }),
        ]
        if (closed) fresh.push(closedEvent(pr.snapshot, { repo, number: pr.number, subject }, false))
        events.push(...decorate(fresh, pr))
      }
      const settled = verdict === "success" || verdict === "failure" || verdict === "neutral"
      next[key] = compactPrState(pr.snapshot, {
        draft: pr.draft,
        closedEmitted: closed,
        // A baseline-time verdict is history; a new PR's first verdict is news.
        ...(known === undefined && settled ? { ciReported: `${pr.snapshot.headSha ?? ""}:${verdict}` } : {}),
      })
      continue
    }
    const diffed = diffRepoPr(prev, pr, repo)
    events.push(...diffed.events)
    next[key] = diffed.next
  }

  const keys = Object.keys(next)
  if (keys.length > REPO_PRS_CAP) {
    for (const k of keys.sort((a, b) => Number(a) - Number(b)).slice(0, keys.length - REPO_PRS_CAP)) delete next[k]
  }
  return { events, repoPrs: next, baselinedAt }
}

// ── Provider ──────────────────────────────────────────────────────────

export interface LocalGhProviderOptions {
  /** Injectable for tests — defaults to the real `gh` binary. */
  gh?: GhRunner
  nowMs?: () => number
  backoffBaseMs?: number
  backoffCapMs?: number
}

export function localGhSentinelProvider(opts?: LocalGhProviderOptions): SentinelProviderHandle {
  const gh = opts?.gh ?? execGh
  const nowMs = opts?.nowMs ?? Date.now
  const backoffBaseMs = opts?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
  const backoffCapMs = opts?.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS

  return {
    slug: LOCAL_GH_SLUG,
    name: "Local GitHub CLI",
    version: "0.1.0",
    description:
      "Zero-infra PR watcher over the host's authenticated `gh` CLI — diffs " +
      "successive review_pr-style snapshots, no webhook, no hosted account.",
    requiresSetup: false,
    capabilities: {
      subjects: ["github"],
      push: false,
      poll: true,
      durable: false,
      needsPublicUrl: false,
      // Uses the host's ambient `gh` auth, not a sentinel-managed credential.
      requiresAuth: false,
      typicalLatencyMs: 30_000,
    },

    async check(): Promise<boolean> {
      try {
        await gh(["auth", "status"])
        return true
      } catch {
        return false
      }
    },

    async create(spec: SentinelSpec, _delivery: DeliveryPreference): Promise<SentinelHandle> {
      if (spec.match.length !== 1) {
        throw new Error(`${LOCAL_GH_SLUG}: exactly one match clause is supported (one sentinel per PR)`)
      }
      const subject = spec.match[0]!.subject
      const repo = parseRepoSubject(subject)
      if (repo) {
        if (spec.until.kind === "subject_terminal") {
          throw new Error(
            `${LOCAL_GH_SLUG}: a repo-wide watch ("${subject}") must use until "never" - the first merged PR would otherwise end it`,
          )
        }
        return { provider: LOCAL_GH_SLUG, remoteId: repo, state: { repo } }
      }
      const identity = parsePrSubject(subject)
      if (!identity || identity.number === undefined) {
        throw new Error(
          `${LOCAL_GH_SLUG}: subject "${subject}" is not a "github:owner/repo#number" PR subject or a "github:owner/repo" repo`,
        )
      }
      return {
        provider: LOCAL_GH_SLUG,
        remoteId: `${identity.repo}#${identity.number}`,
        state: { repo: identity.repo, number: identity.number },
      }
    },

    async attach(handle: SentinelHandle, _delivery: DeliveryPreference): Promise<SentinelHandle> {
      // Nothing external to re-point — the next poll() just resumes from
      // whatever snapshot is already in `handle.cursor`.
      return { ...handle }
    },

    async cancel(_handle: SentinelHandle): Promise<void> {
      // No external resource — local-gh is a pure poll loop.
    },

    async status(handle: SentinelHandle): Promise<{ ok: boolean; detail?: string }> {
      const cursorState = parseCursorState(handle.cursor)
      return cursorState.consecutiveFailures > 0
        ? {
            ok: false,
            detail: cursorState.lastError ?? `gh failing (${cursorState.consecutiveFailures} consecutive failures)`,
          }
        : { ok: true }
    },

    async poll(handle: SentinelHandle, _limit: number): Promise<{ events: SentinelEvent[]; cursor: string }> {
      const identity = parseIdentity(handle.state)
      const cursorState = parseCursorState(handle.cursor)
      if (!identity) {
        return { events: [], cursor: handle.cursor ?? serializeCursorState(cursorState) }
      }
      if (cursorState.nextRetryAtMs !== undefined && nowMs() < cursorState.nextRetryAtMs) {
        return { events: [], cursor: serializeCursorState(cursorState) }
      }

      if (identity.number === undefined) {
        try {
          const prs = await fetchRepoPrs(gh, identity.repo, () => new Date(nowMs()))
          const fetchedAt = new Date(nowMs()).toISOString()
          const diffed = diffRepo(cursorState, prs, identity.repo, fetchedAt)
          return {
            events: diffed.events,
            cursor: serializeCursorState({
              repoPrs: diffed.repoPrs,
              baselinedAt: diffed.baselinedAt,
              consecutiveFailures: 0,
            }),
          }
        } catch (err) {
          const failures = cursorState.consecutiveFailures + 1
          const backoffMs = Math.min(backoffBaseMs * 2 ** (failures - 1), backoffCapMs)
          return {
            events: [],
            cursor: serializeCursorState({
              ...(cursorState.repoPrs ? { repoPrs: cursorState.repoPrs } : {}),
              ...(cursorState.baselinedAt ? { baselinedAt: cursorState.baselinedAt } : {}),
              consecutiveFailures: failures,
              lastError: err instanceof Error ? err.message : String(err),
              nextRetryAtMs: nowMs() + backoffMs,
            }),
          }
        }
      }

      const subject = `github:${identity.repo}#${identity.number}`
      let snapshot: PrStatusSnapshot
      try {
        snapshot = await fetchPrStatus(gh, prRef(identity.repo, identity.number), () => new Date(nowMs()))
      } catch (err) {
        const failures = cursorState.consecutiveFailures + 1
        const backoffMs = Math.min(backoffBaseMs * 2 ** (failures - 1), backoffCapMs)
        return {
          events: [],
          cursor: serializeCursorState({
            ...(cursorState.snapshot ? { snapshot: cursorState.snapshot } : {}),
            consecutiveFailures: failures,
            lastError: err instanceof Error ? err.message : String(err),
            nextRetryAtMs: nowMs() + backoffMs,
          }),
        }
      }

      const ctx = { repo: identity.repo, number: identity.number, subject }
      const events = diffSnapshots(cursorState.snapshot, snapshot, ctx)

      // A PR already merged/closed on the baseline poll (the sentinel was
      // created after it closed, or the PR closed before the first tick) has
      // no open->closed transition to diff, so the terminal event would never
      // fire and `until: subject_terminal` would never expire. Emit it once.
      let closedEmitted = cursorState.closedEmitted ?? false
      if (snapshot.state === "open") closedEmitted = false
      else if (events.some(e => e.terminal)) closedEmitted = true
      else if (!closedEmitted) {
        events.push(closedEvent(snapshot, ctx, true))
        closedEmitted = true
      }

      return {
        events,
        cursor: serializeCursorState({ snapshot, consecutiveFailures: 0, closedEmitted }),
      }
    },

    defaultTypes(subject: string): string[] {
      if (parseRepoSubject(subject)) return [...GITHUB_REPO_DEFAULT_TYPES]
      return parsePrSubject(subject) ? [...GITHUB_DEFAULT_PR_TYPES] : []
    },
  }
}
