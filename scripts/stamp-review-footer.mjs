#!/usr/bin/env node
/**
 * Stamp a DETERMINISTIC provenance footer onto the agentic review the bot just
 * posted. The runner owns the footer — never the model — so the
 * `@agentproto-bot` marker is a reliable native-vs-legacy discriminator AND
 * carries session provenance + cost that the model can't know about itself.
 *
 * Reads (env):
 *   GITHUB_TOKEN   required — posts the PUT
 *   REPO           owner/repo
 *   PR_NUMBER      the PR
 *   SHA            the reviewed commit (review.commit_id must match — fallback)
 *   AUTH_MODE      "subscription" | "api-key"  (from ci.yml)
 *   RUN_ID         the workflow run id
 *   SERVER_URL     ${{ github.server_url }} (for the run link)
 *   PROVENANCE     JSON array from the agentproto-run action's `provenance`
 *                  output — [] / unset when the legacy fallback posted.
 *   ARTIFACTS      JSON array from the action's `artifacts` output — the review
 *                  the delivery helper recorded AT CREATION TIME. Preferred: the
 *                  review is stamped BY ID, no discovery. Empty/absent ⇒ fall
 *                  back to the legacy sha-discovery path (with a ::warning::).
 *
 * Idempotent: if the target review body already carries the marker, it's left
 * as-is. Never fails the job — provenance stamping is cosmetic; a bad stamp
 * must not turn a green review red. Every skip/failure is surfaced as a GitHub
 * `::warning::` annotation so a silently-unstamped review is visible.
 */

import { MARKER, buildFooter } from "./lib/provenance-footer.mjs"
import { parseArtifacts, pickArtifact } from "./lib/artifact-ledger.mjs"

const env = (k) => (process.env[k] ?? "").trim()
const warn = (msg) => console.log(`::warning::stamp-review-footer: ${msg}`)

const api = async (method, path, body) => {
  const res = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : null }
}

/** Newest review authored by a bot against the reviewed SHA. */
const findReview = async (repo, pr, sha) => {
  const reviews = []
  for (let page = 1; page <= 10; page++) {
    const { ok, json } = await api("GET", `repos/${repo}/pulls/${pr}/reviews?per_page=100&page=${page}`)
    if (!ok || !Array.isArray(json) || json.length === 0) break
    reviews.push(...json)
    if (json.length < 100) break
  }
  return reviews
    .filter((r) => r?.commit_id === sha && r?.user?.type === "Bot")
    .sort((a, b) => Date.parse(b.submitted_at ?? 0) - Date.parse(a.submitted_at ?? 0))[0]
}

/** Resolve the session provenance record to cite in the footer. */
const resolveProv = () => {
  let provList = []
  try {
    const parsed = JSON.parse(env("PROVENANCE") || "[]")
    if (Array.isArray(parsed)) provList = parsed
  } catch {
    warn("PROVENANCE not parseable — stamping without session details.")
  }
  // Primary = first session that actually ran an adapter (skip bare shells).
  return provList.find((p) => p?.adapter) || provList[0] || null
}

/** PUT the footer onto a resolved review object. Returns true when it stamped. */
const stampReview = async (repo, pr, review, sha) => {
  if (typeof review?.body === "string" && review.body.includes(MARKER)) {
    console.log(`stamp-review-footer: review ${review.id} already carries the marker — idempotent skip.`)
    return true
  }
  const footer = buildFooter({
    prov: resolveProv(),
    authMode: env("AUTH_MODE"),
    runId: env("RUN_ID"),
    runUrl: `${env("SERVER_URL") || "https://github.com"}/${repo}/actions/runs/${env("RUN_ID")}`,
    sha: sha || review?.commit_id,
    kind: "review",
  })
  const { ok, status, json } = await api(
    "PUT",
    `repos/${repo}/pulls/${pr}/reviews/${review.id}`,
    { body: `${review.body ?? ""}${footer}` },
  )
  if (ok) {
    console.log(`stamp-review-footer: stamped review ${review.id} (${json?.html_url ?? ""}).`)
    return true
  }
  warn(`PUT failed (${status}) — leaving review ${review.id} unstamped: ${JSON.stringify(json)?.slice(0, 200)}`)
  return false
}

async function main() {
  const repo = env("REPO")
  const pr = env("PR_NUMBER")
  const sha = env("SHA")
  if (!env("GITHUB_TOKEN") || !repo || !pr) {
    warn("missing GITHUB_TOKEN/REPO/PR_NUMBER — skipping.")
    return
  }

  // Preferred: the artifact ledger names the exact review this run posted.
  const rec = pickArtifact(parseArtifacts(env("ARTIFACTS")), "review")
  if (rec && rec.id !== undefined) {
    const { ok, json } = await api("GET", `repos/${repo}/pulls/${pr}/reviews/${rec.id}`)
    if (ok && json?.id) {
      await stampReview(repo, pr, json, rec.sha || sha)
      return
    }
    warn(`ledger names review ${rec.id} but it could not be fetched — falling back to discovery.`)
  } else {
    warn("no review in the artifact ledger — falling back to sha discovery (legacy path).")
  }

  // Fallback: discover the newest bot review for the reviewed SHA.
  if (!sha) {
    warn("no SHA to discover a review against — nothing to stamp.")
    return
  }
  const review = await findReview(repo, pr, sha)
  if (!review) {
    warn(`no bot review found for sha ${sha} — nothing to stamp.`)
    return
  }
  await stampReview(repo, pr, review, sha)
}

// Never fail the job over a cosmetic stamp.
main().catch((err) => {
  warn(`${err instanceof Error ? err.message : String(err)} — skipping.`)
})
