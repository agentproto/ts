import type { Classifier, Envelope, Level } from "@agentproto/delivery"

/** Verdicts that need the recipient to act, not just know. */
export const FAILURE_VERDICTS: ReadonlySet<string> = new Set([
  "failure",
  "error",
  "cancelled",
  "timed_out",
  // A review asking for changes, a check suite waiting on a human.
  "changes_requested",
  "action_required",
])

/** The event's own verdict: `conclusion` (check suites/runs, workflow runs)
 *  or `state` (statuses, reviews), lowercased because providers disagree on
 *  casing (webhook `changes_requested`, GraphQL `CHANGES_REQUESTED`), or ""
 *  when it carries neither. */
export function verdictOf(event: Pick<Envelope, "data">): string {
  const conclusion = event.data.conclusion
  if (typeof conclusion === "string") return conclusion.toLowerCase()
  const state = event.data.state
  return typeof state === "string" ? state.toLowerCase() : ""
}

export function isFailureEvent(event: Pick<Envelope, "terminal" | "data">): boolean {
  return event.terminal !== true && FAILURE_VERDICTS.has(verdictOf(event))
}

export type GithubTriageEventClass =
  | "github.check_suite.completed"
  | "github.workflow_run.completed"
  | "github.pull_request_review.submitted"
  | "github.pull_request.closed"
  | "github.pull_request.synchronize"
  | "github.issue_comment.created"

export type GithubTriageDecision = "wake" | "fyi" | "drop"

export interface GithubTriageRuleRow {
  id: string
  eventClass: GithubTriageEventClass
  match: (event: Envelope) => boolean
  decision: GithubTriageDecision
}

function verdictIn(event: Envelope, verdicts: readonly string[]): boolean {
  return verdicts.includes(verdictOf(event))
}

function isBot(event: Envelope): boolean {
  const actor = typeof event.data.actor === "string" ? event.data.actor : ""
  return actor.toLowerCase().endsWith("[bot]")
}

/** The explicit GitHub event-class -> decision table (PR #2444), kept as data
 *  so a new event family is one row rather than a branch in the kernel. */
export const GITHUB_TRIAGE_RULE_TABLE: readonly GithubTriageRuleRow[] = [
  {
    id: "check-suite-failure",
    eventClass: "github.check_suite.completed",
    match: event =>
      verdictIn(event, ["failure", "error", "cancelled", "timed_out", "action_required"]),
    decision: "wake",
  },
  {
    id: "workflow-run-failure",
    eventClass: "github.workflow_run.completed",
    match: event =>
      verdictIn(event, ["failure", "error", "cancelled", "timed_out", "action_required"]),
    decision: "wake",
  },
  {
    id: "review-changes-requested",
    eventClass: "github.pull_request_review.submitted",
    match: event => verdictOf(event) === "changes_requested",
    decision: "wake",
  },
  {
    id: "issue-comment-human",
    eventClass: "github.issue_comment.created",
    match: event => !isBot(event),
    decision: "wake",
  },
  {
    id: "issue-comment-bot",
    eventClass: "github.issue_comment.created",
    match: isBot,
    decision: "fyi",
  },
  {
    id: "pull-request-closed-unmerged",
    eventClass: "github.pull_request.closed",
    match: event => event.data.merged === false,
    decision: "fyi",
  },
  {
    id: "check-suite-success",
    eventClass: "github.check_suite.completed",
    match: event => verdictIn(event, ["success", "neutral", "skipped"]),
    decision: "fyi",
  },
  {
    id: "workflow-run-success",
    eventClass: "github.workflow_run.completed",
    match: event => verdictIn(event, ["success", "neutral", "skipped"]),
    decision: "fyi",
  },
  {
    id: "review-approved-or-commented",
    eventClass: "github.pull_request_review.submitted",
    match: event => verdictIn(event, ["approved", "commented"]),
    decision: "fyi",
  },
  {
    id: "pull-request-closed-merged",
    eventClass: "github.pull_request.closed",
    match: event => event.data.merged === true,
    decision: "fyi",
  },
  {
    id: "pull-request-synchronize",
    eventClass: "github.pull_request.synchronize",
    match: () => true,
    decision: "fyi",
  },
]

function decisionToLevel(decision: GithubTriageDecision): Level {
  if (decision === "wake") return 2
  if (decision === "fyi") return 1
  return 0
}

/** The generic failure rule runs first so any failing verdict wins over the
 *  per-class table; the table rows remain the explicit record of intent. */
const failureClassifier: Classifier = {
  id: "failure",
  types: ["*"],
  classify: env => (isFailureEvent(env) ? decisionToLevel("wake") : undefined),
}

function tableClassifier(row: GithubTriageRuleRow): Classifier {
  return {
    id: `github-triage-table:${row.id}`,
    types: [row.eventClass],
    classify: env => (row.match(env) ? decisionToLevel(row.decision) : undefined),
  }
}

export const GITHUB_CLASSIFIERS: readonly Classifier[] = [
  failureClassifier,
  ...GITHUB_TRIAGE_RULE_TABLE.map(tableClassifier),
]

/** One rule = one GitHub event family's queue slot. */
export interface GithubCoalesceRule {
  id: string
  types: readonly string[]
  key(event: Envelope): string | undefined
}

function matchesType(pattern: string, type: string): boolean {
  if (pattern.endsWith("*")) return type.startsWith(pattern.slice(0, -1))
  return pattern === type
}

/** `headSha` (local-gh / normalize's camelCase) or `head_sha` (GitHub's own
 *  webhook spelling); anything else counts as "no sha" so a family that
 *  emits neither still coalesces per subject. */
function headShaOf(event: Envelope): string {
  const raw = event.data.headSha ?? event.data.head_sha
  return typeof raw === "string" ? raw : ""
}

export const GITHUB_COALESCE_RULES: readonly GithubCoalesceRule[] = [
  {
    id: "github-ci",
    types: ["github.check_suite.*", "github.workflow_run.*", "github.status*", "github.check_run.*"],
    key: event => `ci:${event.subject}:${headShaOf(event)}`,
  },
  {
    id: "github-push",
    types: ["github.pull_request.synchronize"],
    key: event => `push:${event.subject}`,
  },
]

/** First matching rule wins, same namespacing as the sentinel coalesce registry. */
export function githubCoalesceKeyFor(event: Envelope): string | undefined {
  for (const rule of GITHUB_COALESCE_RULES) {
    if (!rule.types.some(pattern => matchesType(pattern, event.type))) continue
    const key = rule.key(event)
    return key === undefined ? undefined : `sentinel:${rule.id}:${key}`
  }
  return undefined
}

/** The producer-set repeat key: coalesce key plus verdict, so a new verdict
 *  on the same head is a new event. A failure carries none, so a repeated
 *  failure on one head is never demoted to a coalesced fyi. */
export function githubRepeatKeyFor(event: Envelope): string | undefined {
  if (isFailureEvent(event)) return undefined
  const key = githubCoalesceKeyFor(event)
  return key === undefined ? undefined : `${key}|${verdictOf(event)}`
}
