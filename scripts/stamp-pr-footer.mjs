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
 *
 * No PR_NUMBER / SHA input — it discovers the just-created PR by looking at
 * open bot PRs whose body still carries the placeholder marker.
 *
 * Idempotent: only PRs whose body still has the placeholder and lack the
 * `@agentproto-bot` marker are stamped. Never fails the job — provenance
 * stamping is cosmetic; a bad stamp must not turn a green run red.
 */

import { MARKER, buildFooter } from "./lib/provenance-footer.mjs"

const PLACEHOLDER = "<!-- agentproto-bot:provenance -->"

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

async function main() {
  const repo = env("REPO")
  const runId = env("RUN_ID")
  if (!env("GITHUB_TOKEN") || !repo || !runId) {
    console.log("stamp-pr-footer: missing GITHUB_TOKEN/REPO/RUN_ID — skipping.")
    return
  }

  const pr = await findPrToStamp(repo)
  if (!pr) {
    console.log("stamp-pr-footer: no unstamped bot PR with placeholder found — nothing to stamp.")
    return
  }

  let provList = []
  try {
    const parsed = JSON.parse(env("PROVENANCE") || "[]")
    if (Array.isArray(parsed)) provList = parsed
  } catch {
    console.log("stamp-pr-footer: PROVENANCE not parseable — stamping without session details.")
  }
  // Primary = first session that actually ran an adapter (skip bare shells).
  const prov = provList.find((p) => p?.adapter) || provList[0] || null

  const footer = buildFooter({
    prov,
    authMode: env("AUTH_MODE"),
    runId,
    runUrl: `${env("SERVER_URL") || "https://github.com"}/${repo}/actions/runs/${runId}`,
    sha: pr.head?.sha,
    kind: "PR",
  })

  const newBody = `${stripPlaceholder(pr.body)}${footer}`
  const { ok, status, json } = await api("PATCH", `repos/${repo}/pulls/${pr.number}`, { body: newBody })
  if (ok) console.log(`stamp-pr-footer: stamped PR ${pr.number} (${json?.html_url ?? ""}).`)
  else console.log(`stamp-pr-footer: PATCH failed (${status}) — leaving PR unstamped: ${JSON.stringify(json)?.slice(0, 200)}`)
}

// Never fail the job over a cosmetic stamp.
main().catch((err) => {
  console.log(`stamp-pr-footer: ${err instanceof Error ? err.message : String(err)} — skipping.`)
})
