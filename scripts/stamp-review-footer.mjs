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
 *   SHA            the reviewed commit (review.commit_id must match)
 *   AUTH_MODE      "subscription" | "api-key"  (from ci.yml)
 *   RUN_ID         the workflow run id
 *   SERVER_URL     ${{ github.server_url }} (for the run link)
 *   PROVENANCE     JSON array from the agentproto-run action's `provenance`
 *                  output — [] / unset when the legacy fallback posted.
 *
 * Idempotent: if the target review body already carries the marker, it's left
 * as-is. Never fails the job — provenance stamping is cosmetic; a bad stamp
 * must not turn a green review red.
 */

import { MARKER, buildFooter } from "./lib/provenance-footer.mjs"

const env = (k) => (process.env[k] ?? "").trim()

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

async function main() {
  const repo = env("REPO")
  const pr = env("PR_NUMBER")
  const sha = env("SHA")
  if (!env("GITHUB_TOKEN") || !repo || !pr || !sha) {
    console.log("stamp-review-footer: missing GITHUB_TOKEN/REPO/PR_NUMBER/SHA — skipping.")
    return
  }

  const review = await findReview(repo, pr, sha)
  if (!review) {
    console.log(`stamp-review-footer: no bot review found for sha ${sha} — nothing to stamp.`)
    return
  }
  if (typeof review.body === "string" && review.body.includes(MARKER)) {
    console.log(`stamp-review-footer: review ${review.id} already carries the marker — idempotent skip.`)
    return
  }

  let provList = []
  try {
    const parsed = JSON.parse(env("PROVENANCE") || "[]")
    if (Array.isArray(parsed)) provList = parsed
  } catch {
    console.log("stamp-review-footer: PROVENANCE not parseable — stamping without session details.")
  }
  // Primary = first session that actually ran an adapter (skip bare shells).
  const prov = provList.find((p) => p?.adapter) || provList[0] || null

  const footer = buildFooter({
    prov,
    authMode: env("AUTH_MODE"),
    runId: env("RUN_ID"),
    runUrl: `${env("SERVER_URL") || "https://github.com"}/${repo}/actions/runs/${env("RUN_ID")}`,
    sha,
    kind: "review",
  })

  const { ok, status, json } = await api(
    "PUT",
    `repos/${repo}/pulls/${pr}/reviews/${review.id}`,
    { body: `${review.body ?? ""}${footer}` },
  )
  if (ok) console.log(`stamp-review-footer: stamped review ${review.id} (${json?.html_url ?? ""}).`)
  else console.log(`stamp-review-footer: PUT failed (${status}) — leaving review unstamped: ${JSON.stringify(json)?.slice(0, 200)}`)
}

// Never fail the job over a cosmetic stamp.
main().catch((err) => {
  console.log(`stamp-review-footer: ${err instanceof Error ? err.message : String(err)} — skipping.`)
})
