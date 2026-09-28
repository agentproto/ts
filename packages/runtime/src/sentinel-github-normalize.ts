/**
 * Pure GitHub webhook -> CloudEvents `SentinelEvent` normalizer (AIP-60 §4).
 *
 * No I/O, no adapter-kit — a plain function so it can be the SAME normalizer
 * both the (future) `webhook` sentinel provider and agentpush's GitHub
 * source call, byte-identical `type`/`subject`/`data` either way (design
 * §7.3's shared-module requirement). Scope for step 2: the five event types
 * that make up the default PR watch set (design §4's "Default PR type
 * set") — `pull_request`, `pull_request_review`, `check_suite`,
 * `workflow_run`, `issue_comment`. Unrecognized events return `ok: false`
 * rather than throwing — a webhook ingress caller decides what to do with
 * an event it doesn't watch (ack and drop, typically).
 *
 * Field access is defensive (typeof guards, no blind casts) because a
 * webhook payload is untrusted input: a malformed or unexpected shape
 * degrades to `ok: false`, never a thrown exception.
 */

import type { SentinelEvent } from "./sentinel-providers/types.js"

// ── Default PR type set (design §4) ──────────────────────────────────

/** `check_run.*` is deliberately excluded — noise (design §4). */
export const GITHUB_DEFAULT_PR_TYPES: readonly string[] = [
  "github.check_suite.completed",
  "github.workflow_run.completed",
  "github.pull_request_review.submitted",
  "github.pull_request.closed",
  "github.issue_comment.created",
]

// ── Input / output ────────────────────────────────────────────────────

export interface GithubNormalizeInput {
  /** `X-GitHub-Event` header value, e.g. "pull_request". */
  event: string
  /** `X-GitHub-Delivery` header value — GitHub's own stable-across-retries
   *  id, folded into `evt_<deliveryId>` (design §4: "agentpush keeps
   *  GitHub's X-GitHub-Delivery inside its id"). */
  deliveryId: string
  /** Parsed JSON webhook body. */
  payload: unknown
  /** Overrides the CloudEvents `source` URI. Default
   *  `//agentproto.local/sentinel/github`. */
  source?: string
  /** Overrides `time` (ISO-8601). Default `new Date().toISOString()` —
   *  GitHub webhook payloads carry no single canonical delivery timestamp
   *  field across event types, so this is processing time unless the
   *  caller knows better (e.g. replaying a stored delivery). */
  time?: string
}

export type GithubNormalizeResult =
  | { ok: true; event: SentinelEvent }
  | { ok: false; reason: string }

// ── Accessor helpers (untrusted JSON -> typed reads) ─────────────────

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}
function str(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key]
  return typeof v === "string" ? v : undefined
}
function num(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = obj?.[key]
  return typeof v === "number" ? v : undefined
}
function bool(obj: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const v = obj?.[key]
  return typeof v === "boolean" ? v : undefined
}
function arr(obj: Record<string, unknown> | undefined, key: string): unknown[] {
  const v = obj?.[key]
  return Array.isArray(v) ? v : []
}

interface RepoParts {
  owner: string
  repo: string
}

function repoParts(payload: Record<string, unknown>): RepoParts | undefined {
  const repository = asObject(payload.repository)
  const fullName = str(repository, "full_name")
  if (fullName) {
    const idx = fullName.indexOf("/")
    if (idx > 0) return { owner: fullName.slice(0, idx), repo: fullName.slice(idx + 1) }
  }
  const ownerLogin = str(asObject(repository?.owner), "login")
  const repoName = str(repository, "name")
  if (ownerLogin && repoName) return { owner: ownerLogin, repo: repoName }
  return undefined
}

function prSubject(owner: string, repo: string, number: number): string {
  return `github:${owner}/${repo}#${number}`
}
function repoSubject(owner: string, repo: string): string {
  return `github:${owner}/${repo}`
}
function ownerSubject(owner: string): string {
  return `github:${owner}`
}
/** Full subject hierarchy, most specific first (design §4). */
function subjectsFor(owner: string, repo: string, number?: number): string[] {
  return number !== undefined
    ? [prSubject(owner, repo, number), repoSubject(owner, repo), ownerSubject(owner)]
    : [repoSubject(owner, repo), ownerSubject(owner)]
}

interface BaseFields {
  deliveryId: string
  source: string
  time: string
}

function actorOf(payload: Record<string, unknown>, ...fallbacks: (Record<string, unknown> | undefined)[]): string {
  for (const obj of fallbacks) {
    const login = str(asObject(obj?.user), "login")
    if (login) return login
  }
  return str(asObject(payload.sender), "login") ?? ""
}

// ── Per-event normalizers ─────────────────────────────────────────────

function normalizePullRequest(payload: Record<string, unknown>, base: BaseFields): GithubNormalizeResult {
  const parts = repoParts(payload)
  if (!parts) return { ok: false, reason: "missing_repository" }
  const action = str(payload, "action")
  if (!action) return { ok: false, reason: "missing_action" }
  const pr = asObject(payload.pull_request)
  const number = num(pr, "number") ?? num(payload, "number")
  if (number === undefined) return { ok: false, reason: "missing_pull_request_number" }
  const merged = bool(pr, "merged") ?? false
  const title = str(pr, "title") ?? ""
  const url = str(pr, "html_url") ?? ""
  const actor = actorOf(payload, pr)
  const headSha = str(asObject(pr?.head), "sha") ?? ""

  const summary =
    action === "closed"
      ? merged
        ? `PR ${parts.owner}/${parts.repo}#${number} merged by ${actor}`
        : `PR ${parts.owner}/${parts.repo}#${number} closed by ${actor}`
      : `PR ${parts.owner}/${parts.repo}#${number} ${action} by ${actor}`

  return {
    ok: true,
    event: {
      specversion: "1.0",
      id: `evt_${base.deliveryId}`,
      source: base.source,
      type: `github.pull_request.${action}`,
      subject: prSubject(parts.owner, parts.repo, number),
      time: base.time,
      datacontenttype: "application/json",
      data: {
        action,
        merged,
        repo: `${parts.owner}/${parts.repo}`,
        number,
        title,
        url,
        actor,
        head_sha: headSha,
      },
      summary,
      subjects: subjectsFor(parts.owner, parts.repo, number),
      terminal: action === "closed",
    },
  }
}

function normalizePullRequestReview(payload: Record<string, unknown>, base: BaseFields): GithubNormalizeResult {
  const parts = repoParts(payload)
  if (!parts) return { ok: false, reason: "missing_repository" }
  const action = str(payload, "action")
  if (!action) return { ok: false, reason: "missing_action" }
  const pr = asObject(payload.pull_request)
  const number = num(pr, "number")
  if (number === undefined) return { ok: false, reason: "missing_pull_request_number" }
  const review = asObject(payload.review)
  const state = str(review, "state") ?? "unknown"
  const actor = actorOf(payload, review)

  return {
    ok: true,
    event: {
      specversion: "1.0",
      id: `evt_${base.deliveryId}`,
      source: base.source,
      type: `github.pull_request_review.${action}`,
      subject: prSubject(parts.owner, parts.repo, number),
      time: base.time,
      datacontenttype: "application/json",
      data: { action, state, repo: `${parts.owner}/${parts.repo}`, number, actor },
      summary: `PR ${parts.owner}/${parts.repo}#${number} review ${state} by ${actor}`,
      subjects: subjectsFor(parts.owner, parts.repo, number),
      terminal: false,
    },
  }
}

/** Shared shape for `check_suite`/`workflow_run` — both key off a nested
 *  object carrying `pull_requests[]` (subject source) and `head_branch`
 *  (repo-level fallback context) (design §7.4: "PR number for
 *  check_suite/workflow_run/status comes from pull_requests[]; when empty,
 *  subject is the repo with data.head_branch"). */
function repoOrPrSubject(
  parts: RepoParts,
  nested: Record<string, unknown> | undefined,
): { subject: string; subjects: string[]; number?: number; headBranch?: string; target: string } {
  const prs = arr(nested, "pull_requests")
  const number = num(asObject(prs[0]), "number")
  const headBranch = str(nested, "head_branch")
  const subject = number !== undefined ? prSubject(parts.owner, parts.repo, number) : repoSubject(parts.owner, parts.repo)
  const subjects = subjectsFor(parts.owner, parts.repo, number)
  const target =
    number !== undefined
      ? `${parts.owner}/${parts.repo}#${number}`
      : `${parts.owner}/${parts.repo}${headBranch ? ` (${headBranch})` : ""}`
  return { subject, subjects, ...(number !== undefined ? { number } : {}), ...(headBranch ? { headBranch } : {}), target }
}

function normalizeCheckSuite(payload: Record<string, unknown>, base: BaseFields): GithubNormalizeResult {
  const parts = repoParts(payload)
  if (!parts) return { ok: false, reason: "missing_repository" }
  const action = str(payload, "action")
  if (!action) return { ok: false, reason: "missing_action" }
  const suite = asObject(payload.check_suite)
  const conclusion = str(suite, "conclusion")
  const located = repoOrPrSubject(parts, suite)

  return {
    ok: true,
    event: {
      specversion: "1.0",
      id: `evt_${base.deliveryId}`,
      source: base.source,
      type: `github.check_suite.${action}`,
      subject: located.subject,
      time: base.time,
      datacontenttype: "application/json",
      data: {
        action,
        conclusion: conclusion ?? null,
        repo: `${parts.owner}/${parts.repo}`,
        ...(located.number !== undefined ? { number: located.number } : {}),
        ...(located.headBranch ? { head_branch: located.headBranch } : {}),
      },
      summary: `Check suite ${conclusion ?? action} for ${located.target}`,
      subjects: located.subjects,
      terminal: false,
    },
  }
}

function normalizeWorkflowRun(payload: Record<string, unknown>, base: BaseFields): GithubNormalizeResult {
  const parts = repoParts(payload)
  if (!parts) return { ok: false, reason: "missing_repository" }
  const action = str(payload, "action")
  if (!action) return { ok: false, reason: "missing_action" }
  const run = asObject(payload.workflow_run)
  const name = str(run, "name") ?? "workflow"
  const conclusion = str(run, "conclusion")
  const located = repoOrPrSubject(parts, run)

  return {
    ok: true,
    event: {
      specversion: "1.0",
      id: `evt_${base.deliveryId}`,
      source: base.source,
      type: `github.workflow_run.${action}`,
      subject: located.subject,
      time: base.time,
      datacontenttype: "application/json",
      data: {
        action,
        name,
        conclusion: conclusion ?? null,
        repo: `${parts.owner}/${parts.repo}`,
        ...(located.number !== undefined ? { number: located.number } : {}),
        ...(located.headBranch ? { head_branch: located.headBranch } : {}),
      },
      summary: `Workflow run "${name}" ${conclusion ?? action} for ${located.target}`,
      subjects: located.subjects,
      terminal: false,
    },
  }
}

function normalizeIssueComment(payload: Record<string, unknown>, base: BaseFields): GithubNormalizeResult {
  const parts = repoParts(payload)
  if (!parts) return { ok: false, reason: "missing_repository" }
  const action = str(payload, "action")
  if (!action) return { ok: false, reason: "missing_action" }
  const issue = asObject(payload.issue)
  const number = num(issue, "number")
  if (number === undefined) return { ok: false, reason: "missing_issue_number" }
  const comment = asObject(payload.comment)
  const actor = actorOf(payload, comment)
  const url = str(comment, "html_url") ?? ""
  const isPullRequest = asObject(issue?.pull_request) !== undefined

  return {
    ok: true,
    event: {
      specversion: "1.0",
      id: `evt_${base.deliveryId}`,
      source: base.source,
      type: `github.issue_comment.${action}`,
      subject: prSubject(parts.owner, parts.repo, number),
      time: base.time,
      datacontenttype: "application/json",
      data: {
        action,
        repo: `${parts.owner}/${parts.repo}`,
        number,
        actor,
        url,
        is_pull_request: isPullRequest,
      },
      summary: `New comment on ${parts.owner}/${parts.repo}#${number} by ${actor}`,
      subjects: subjectsFor(parts.owner, parts.repo, number),
      terminal: false,
    },
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────

export function normalizeGithubEvent(input: GithubNormalizeInput): GithubNormalizeResult {
  const payload = asObject(input.payload)
  if (!payload) return { ok: false, reason: "invalid_payload" }

  const base: BaseFields = {
    deliveryId: input.deliveryId,
    source: input.source ?? "//agentproto.local/sentinel/github",
    time: input.time ?? new Date().toISOString(),
  }

  switch (input.event) {
    case "pull_request":
      return normalizePullRequest(payload, base)
    case "pull_request_review":
      return normalizePullRequestReview(payload, base)
    case "check_suite":
      return normalizeCheckSuite(payload, base)
    case "workflow_run":
      return normalizeWorkflowRun(payload, base)
    case "issue_comment":
      return normalizeIssueComment(payload, base)
    default:
      return { ok: false, reason: `unsupported_event:${input.event}` }
  }
}
