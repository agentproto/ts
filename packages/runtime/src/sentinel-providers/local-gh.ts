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
  number: number
}

const GITHUB_PR_SUBJECT_RE = /^github:([^/]+\/[^#]+)#(\d+)$/

function parsePrSubject(subject: string): LocalGhIdentity | undefined {
  const m = GITHUB_PR_SUBJECT_RE.exec(subject)
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined
}

function parseIdentity(state: Record<string, unknown> | undefined): LocalGhIdentity | undefined {
  const repo = state?.repo
  const number = state?.number
  return typeof repo === "string" && typeof number === "number" ? { repo, number } : undefined
}

// ── Cursor blob (mutable poll state — see module doc) ────────────────────

interface LocalGhCursorState {
  snapshot?: PrStatusSnapshot
  consecutiveFailures: number
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
    const merged = current.state === "merged"
    events.push(
      makeEvent({
        // `fetchedAt` (not just prTag+state) so a reopen-then-close within
        // one watch produces two distinct ids instead of deduping the second.
        idParts: [prTag, "closed", current.state, current.fetchedAt],
        type: "github.pull_request.closed",
        subject: ctx.subject,
        subjects,
        terminal: true,
        time: current.fetchedAt,
        data: { action: "closed", merged, repo: ctx.repo, number: ctx.number },
        summary: merged ? `PR ${prTag} merged` : `PR ${prTag} closed`,
      }),
    )
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
      const identity = parsePrSubject(spec.match[0]!.subject)
      if (!identity) {
        throw new Error(
          `${LOCAL_GH_SLUG}: subject "${spec.match[0]!.subject}" is not a "github:owner/repo#number" PR subject`,
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

      const events = diffSnapshots(cursorState.snapshot, snapshot, {
        repo: identity.repo,
        number: identity.number,
        subject,
      })

      return {
        events,
        cursor: serializeCursorState({ snapshot, consecutiveFailures: 0 }),
      }
    },

    defaultTypes(subject: string): string[] {
      return parsePrSubject(subject) ? [...GITHUB_DEFAULT_PR_TYPES] : []
    },
  }
}
