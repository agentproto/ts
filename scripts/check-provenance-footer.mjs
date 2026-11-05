#!/usr/bin/env node
/**
 * Hygiene check: a PR opened under the shared `agentiknet` account must carry
 * the rendered agentproto provenance footer, with a bounded GRACE PERIOD.
 *
 * Why a grace period: every lane that stamps the footer does it AFTER the PR
 * exists. The gh shim (`gh-provenance-shim.ts`), the daemon `pr_open` lane and
 * the `command_execute` stamper all run `gh pr create` first and PATCH the
 * footer on afterwards; the daemon reconciler waits for the session's
 * turn-end; the cloud reviewer stamps a footer-less PR several minutes later.
 * So the PR's `opened` event always fires on a body without one, and a check
 * that reads the body once (~20-50 s after `opened`) goes red on PRs whose
 * footer lands a few minutes later (agentproto/ts#2541, #2542: footer at
 * +5m21s and +5m58s). The `pull_request` trigger does not include `edited`,
 * so that red stayed until someone pushed again.
 *
 * Not a permanent weakening: the check still fails when the footer is absent
 * once the grace period is over. Only the time it waits changes.
 *
 * Reads (env):
 *   PR_NUMBER                  PR to poll via `gh pr view` (needs GH_TOKEN)
 *   PR_BODY                    body already fetched by the caller; checked
 *                              first, so a stamped PR costs no extra API call
 *   PROVENANCE_GRACE_SECONDS   how long to keep polling (default 600)
 *   PROVENANCE_POLL_SECONDS    delay between polls (default 20)
 *
 * Exit 0 when the footer is present (now or within the grace period), 1 when
 * it never showed up.
 */

import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"

/** A RENDERED footer (`<sub>…@agentproto-bot…`), not a bare mention of the
 *  marker in prose. Keep in sync with hasProvenanceFooter in
 *  packages/runtime/src/pr-provenance.ts. */
export const PROVENANCE_PATTERN = /<sub>[^<]*@agentproto-bot/

export const DEFAULT_GRACE_SECONDS = 600
export const DEFAULT_POLL_SECONDS = 20

export function hasProvenanceFooter(body) {
  return typeof body === "string" && PROVENANCE_PATTERN.test(body)
}

/**
 * Poll `fetchBody` until the body carries a footer or `graceMs` has elapsed.
 * `initialBody`, when given, counts as the first observation. A failed fetch
 * is treated as "not yet" (logged via `log`), never as a verdict: the final
 * answer is only ever "a footer was seen" or "none was seen in time".
 */
export async function waitForProvenanceFooter({
  initialBody,
  fetchBody,
  graceMs = DEFAULT_GRACE_SECONDS * 1000,
  intervalMs = DEFAULT_POLL_SECONDS * 1000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = () => {},
}) {
  const deadline = now() + graceMs
  let attempts = 0
  if (initialBody !== undefined) {
    attempts++
    if (hasProvenanceFooter(initialBody)) return { found: true, attempts }
  }
  while (now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())))
    attempts++
    let body
    try {
      body = await fetchBody()
    } catch (err) {
      log(`fetching the PR body failed (${err instanceof Error ? err.message : String(err)}), retrying`)
      continue
    }
    if (hasProvenanceFooter(body)) return { found: true, attempts }
  }
  return { found: false, attempts }
}

function seconds(raw, fallback) {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

async function main() {
  const prNumber = (process.env.PR_NUMBER ?? "").trim()
  const graceS = seconds(process.env.PROVENANCE_GRACE_SECONDS, DEFAULT_GRACE_SECONDS)
  const pollS = seconds(process.env.PROVENANCE_POLL_SECONDS, DEFAULT_POLL_SECONDS)
  if (!prNumber && process.env.PR_BODY === undefined) {
    console.error("check-provenance-footer: set PR_NUMBER (or PR_BODY)")
    process.exit(2)
  }
  const fetchBody = () => {
    if (!prNumber) throw new Error("no PR_NUMBER to poll")
    return execFileSync("gh", ["pr", "view", prNumber, "--json", "body", "-q", ".body"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    })
  }
  const initialBody = process.env.PR_BODY
  if (initialBody !== undefined && !hasProvenanceFooter(initialBody) && graceS > 0) {
    console.log(
      `No provenance footer yet; polling the PR body every ${pollS}s for up to ${graceS}s ` +
        "(every stamping lane edits the body after the PR is opened).",
    )
  }
  const result = await waitForProvenanceFooter({
    initialBody,
    fetchBody,
    graceMs: graceS * 1000,
    intervalMs: pollS * 1000,
    log: (msg) => console.log(msg),
  })
  if (result.found) {
    if (result.attempts > 1) console.log(`Provenance footer appeared after ${result.attempts} checks.`)
    process.exit(0)
  }
  process.exit(1)
}

// Compare real paths: run through a symlinked path, `import.meta.url` is
// already resolved and a plain compare would skip main() and exit 0.
const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : ""
if (import.meta.url === entry) {
  await main()
}
