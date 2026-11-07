#!/usr/bin/env node
/**
 * Reconcile a reviewer's STRUCTURED verdict with the GitHub review state it
 * actually posted.
 *
 * A reviewer can state an approve in its structured verdict and still post the
 * review as COMMENTED (`gh pr review --comment`), which GitHub does not count
 * toward the review decision - the PR stays REVIEW_REQUIRED (PR #2616, run
 * 42326443318). `deliver-artifact.mjs#reconcileReviewEvent` fixes the sandbox
 * delivery path; this is the HOST-placement counterpart, run by CI after the
 * reviewer finishes, keyed on the structured verdict the workflow produced.
 *
 * The decision is pure and exported for tests (`decideReviewReconciliation`);
 * `main` only fetches the PR's reviews, applies the decision, and posts.
 *
 * Usage (from the repo root, in the pr-review job):
 *   node .github/agentproto-workflows/lib/reconcile-review-state.mjs
 *
 * Env: GITHUB_TOKEN, REPO, PR_NUMBER, HEAD_SHA (the sha the review is on),
 * VERDICT_PRIMARY / VERDICT_FALLBACK / VERDICT_OPENCODE (the agentproto-run
 * `summary-verdict` outputs; the first decisive one wins).
 *
 * Exit code: 0 on a no-op or a successful post, 1 when the API call fails.
 */

import { pathToFileURL } from "node:url"

const GITHUB_API = "https://api.github.com"

const env = (key) => (process.env[key] ?? "").trim()

/** "approved"/"approve" -> "approve"; "changes_requested"/"request_changes" -> "request_changes". */
export const normalizeConclusion = (value) => {
  const v = String(value ?? "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")
  if (v === "approve" || v === "approved") return "approve"
  if (v === "request_changes" || v === "requested_changes" || v === "changes_requested") return "request_changes"
  return undefined
}

/**
 * The first DECISIVE structured verdict among the tiers, in order. Tiers that
 * did not run (empty) or did not produce a review verdict (incomplete/failed)
 * are skipped, so a failed primary never masks a fallback tier's approve.
 */
export const pickConclusion = (candidates) => {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const conclusion = normalizeConclusion(candidate)
    if (conclusion) return conclusion
  }
  return undefined
}

/** A GitHub review authored by a bot (the reviewer tiers all post as a Bot). */
export const isBotReview = (review) => review?.user?.type === "Bot"

const stateOf = (review) => String(review?.state ?? "").toUpperCase()
const submittedAt = (review) => Date.parse(review?.submitted_at ?? "") || 0

/**
 * Decide whether the verdict needs a follow-up review on `headSha`.
 *
 * - `verdict`: the structured conclusion ("approve" | "request_changes", or the
 *   summary-verdict spellings). An absent/unrecognized value is a no-op.
 * - `reviews`: the PR's reviews in GitHub REST shape (any sha - filtered here).
 * - `headSha`: the commit the reviewer's review was posted against.
 *
 * Returns `{ action: "none" | "submit", event?, body?, reason }`. It submits
 * only when the LATEST bot review on `headSha` is COMMENTED and no bot review
 * already carries the SAME decisive event on that sha (idempotent). Any other
 * decisive state is left alone: a deliberate APPROVE or REQUEST_CHANGES is
 * never overridden.
 */
export const decideReviewReconciliation = ({ verdict, reviews = [], headSha }) => {
  const conclusion = normalizeConclusion(verdict)
  if (!conclusion) return { action: "none", reason: "no decisive structured verdict to reconcile" }
  if (!headSha) return { action: "none", reason: "no head sha to reconcile against" }

  const event = conclusion === "approve" ? "APPROVE" : "REQUEST_CHANGES"
  // GitHub's REVIEW STATE is APPROVED / CHANGES_REQUESTED; the review EVENT is
  // APPROVE / REQUEST_CHANGES. Idempotency matches the state.
  const state = event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED"
  const onHead = (Array.isArray(reviews) ? reviews : []).filter(
    (review) => review?.commit_id === headSha && isBotReview(review),
  )

  if (onHead.some((review) => stateOf(review) === state)) {
    return { action: "none", event, reason: `a bot ${event} review already exists on ${headSha}` }
  }

  const latest = [...onHead].sort((a, b) => submittedAt(b) - submittedAt(a))[0]
  if (!latest) return { action: "none", event, reason: `no bot review on ${headSha} to reconcile` }
  if (stateOf(latest) !== "COMMENTED") {
    return {
      action: "none",
      event,
      reason: `latest bot review on ${headSha} is ${stateOf(latest) || "unknown"}, not COMMENTED`,
    }
  }

  const stated = conclusion === "approve" ? "approve" : "request-changes"
  return {
    action: "submit",
    event,
    reason: `latest bot review ${latest.id ?? "(no id)"} on ${headSha} is COMMENTED but the verdict is ${conclusion}`,
    body: `Upgrades the reviewer's stated ${stated} verdict to a ${event} review (the posted review was COMMENTED, which GitHub does not count toward the review decision).`,
  }
}

const api = async (token, method, path, body) => {
  const res = await fetch(`${GITHUB_API}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // non-JSON body - leave json null
  }
  return { ok: res.ok, status: res.status, json }
}

const listReviews = async (token, repo, pr) => {
  const reviews = []
  for (let page = 1; page <= 10; page++) {
    const { ok, status, json } = await api(
      token,
      "GET",
      `repos/${repo}/pulls/${pr}/reviews?per_page=100&page=${page}`,
    )
    if (!ok) throw new Error(`listing reviews failed (status ${status})`)
    if (!Array.isArray(json) || json.length === 0) break
    reviews.push(...json)
    if (json.length < 100) break
  }
  return reviews
}

async function main() {
  const token = env("GITHUB_TOKEN")
  const repo = env("REPO")
  const pr = env("PR_NUMBER")
  if (!token || !repo || !pr) {
    console.log("::warning::reconcile-review-state: missing GITHUB_TOKEN/REPO/PR_NUMBER - skipping.")
    return 0
  }

  const verdict = pickConclusion([
    env("VERDICT_PRIMARY"),
    env("VERDICT_FALLBACK"),
    env("VERDICT_OPENCODE"),
  ])
  if (!verdict) {
    console.log("reconcile-review-state: no decisive structured verdict - nothing to reconcile.")
    return 0
  }

  const headSha = env("HEAD_SHA")
  if (!headSha) {
    console.log("::warning::reconcile-review-state: no HEAD_SHA - nothing to reconcile.")
    return 0
  }

  let reviews
  try {
    reviews = await listReviews(token, repo, pr)
  } catch (err) {
    console.error(`::warning::reconcile-review-state: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  const decision = decideReviewReconciliation({ verdict, reviews, headSha })
  if (decision.action !== "submit") {
    console.log(`reconcile-review-state: ${decision.reason} - nothing to post.`)
    return 0
  }

  const { ok, status, json } = await api(token, "POST", `repos/${repo}/pulls/${pr}/reviews`, {
    commit_id: headSha,
    event: decision.event,
    body: decision.body,
  })
  if (!ok) {
    console.error(
      `::warning::reconcile-review-state: posting ${decision.event} failed (status ${status}): ${JSON.stringify(json)?.slice(0, 300)}`,
    )
    return 1
  }
  console.log(
    `reconcile-review-state: posted ${decision.event} on ${headSha} (review id ${json?.id ?? "?"}) - ${decision.reason}`,
  )
  return 0
}

// Only run when invoked directly - importing for tests pulls the pure exports.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code))
}
