#!/usr/bin/env node
/**
 * Stamp a DETERMINISTIC provenance footer onto the PR body the bot just
 * created. The runner owns the footer — never the model — so the
 * `@agentproto-bot` marker is a reliable native-vs-legacy discriminator AND
 * carries session provenance + cost that the model can't know about itself.
 *
 * Reads (env):
 *   GITHUB_TOKEN   required — posts the PATCH
 *   REPO           owner/repo
 *   RUN_ID         the workflow run id
 *   SERVER_URL     ${{ github.server_url }} (for the run link)
 *   AUTH_MODE      "subscription" | "api-key"  (from ci.yml)
 *   PROVENANCE     JSON array from the agentproto-run action's `provenance`
 *                  output — [] / unset when the legacy fallback posted.
 *   ARTIFACTS      JSON array from the action's `artifacts` output — the PR the
 *                  delivery helper recorded AT CREATION TIME. Preferred: the PR
 *                  is stamped BY ID, no discovery. Empty/absent ⇒ fall back to
 *                  the legacy placeholder-discovery path (with a ::warning::).
 *
 * The ledger path stamps the exact PR the run created. The discovery FALLBACK
 * (kept for in-flight/legacy PRs) finds the just-created PR by scanning open
 * bot PRs whose body still carries the placeholder marker.
 *
 * Idempotent: a PR that already carries the `@agentproto-bot` marker is left
 * as-is. Never fails the job — provenance stamping is cosmetic; a bad stamp
 * must not turn a green run red. Every skip/failure is surfaced as a GitHub
 * `::warning::` annotation so a silently-unstamped PR is visible, not buried.
 */

import { MARKER, buildFooter } from "./lib/provenance-footer.mjs"
import { parseArtifacts, pickArtifact } from "./lib/artifact-ledger.mjs"

const PLACEHOLDER = "<!-- agentproto-bot:provenance -->"

const env = (k) => (process.env[k] ?? "").trim()
const warn = (msg) => console.log(`::warning::stamp-pr-footer: ${msg}`)

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

/** Newest open bot PR whose body still carries the placeholder and is not yet stamped. */
const findPrToStamp = async (repo) => {
  const { ok, json } = await api("GET", `repos/${repo}/pulls?state=open&sort=created&direction=desc&per_page=30`)
  if (!ok || !Array.isArray(json)) return null
  return json.find((pr) => {
    const body = typeof pr.body === "string" ? pr.body : ""
    return (
      body.includes(PLACEHOLDER) &&
      !body.includes(MARKER) &&
      pr.user?.type === "Bot" &&
      String(pr.head?.ref || "").startsWith("bot/")
    )
  })
}

const stripPlaceholder = (body) => {
  if (typeof body !== "string") return ""
  return body.split("\n").filter((line) => line.trim() !== PLACEHOLDER).join("\n").trim()
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

/** PATCH the footer onto a resolved PR object. Returns true when it stamped. */
const stampPr = async (repo, pr, runId) => {
  if (typeof pr?.body === "string" && pr.body.includes(MARKER)) {
    console.log(`stamp-pr-footer: PR ${pr.number} already carries the marker — idempotent skip.`)
    return true
  }
  const footer = buildFooter({
    prov: resolveProv(),
    authMode: env("AUTH_MODE"),
    runId,
    runUrl: `${env("SERVER_URL") || "https://github.com"}/${repo}/actions/runs/${runId}`,
    sha: pr.head?.sha,
    kind: "PR",
  })
  const newBody = `${stripPlaceholder(pr.body)}${footer}`
  const { ok, status, json } = await api("PATCH", `repos/${repo}/pulls/${pr.number}`, { body: newBody })
  if (ok) {
    console.log(`stamp-pr-footer: stamped PR ${pr.number} (${json?.html_url ?? ""}).`)
    return true
  }
  warn(`PATCH failed (${status}) — leaving PR ${pr.number} unstamped: ${JSON.stringify(json)?.slice(0, 200)}`)
  return false
}

async function main() {
  const repo = env("REPO")
  const runId = env("RUN_ID")
  if (!env("GITHUB_TOKEN") || !repo || !runId) {
    warn("missing GITHUB_TOKEN/REPO/RUN_ID — skipping.")
    return
  }

  // Preferred: the artifact ledger names the exact PR this run created.
  const rec = pickArtifact(parseArtifacts(env("ARTIFACTS")), "pr")
  if (rec && rec.number !== undefined) {
    const { ok, json } = await api("GET", `repos/${repo}/pulls/${rec.number}`)
    if (ok && json?.number) {
      await stampPr(repo, json, runId)
      return
    }
    warn(`ledger names PR #${rec.number} but it could not be fetched — falling back to discovery.`)
  } else if (rec) {
    warn(`ledger PR record has no number (id=${rec.id}) — falling back to discovery.`)
  } else {
    warn("no PR in the artifact ledger — falling back to placeholder discovery (legacy path).")
  }

  // Fallback: discover the just-created PR by its placeholder marker.
  const pr = await findPrToStamp(repo)
  if (!pr) {
    warn("no unstamped bot PR with placeholder found — nothing to stamp.")
    return
  }
  await stampPr(repo, pr, runId)
}

// Never fail the job over a cosmetic stamp.
main().catch((err) => {
  warn(`${err instanceof Error ? err.message : String(err)} — skipping.`)
})
