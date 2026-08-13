#!/usr/bin/env node
/**
 * Shared GitHub delivery + artifact-ledger writer, run INSIDE the sandbox box.
 *
 * A fresh e2b box has no `gh` CLI, so the review/pr/fix flows used to POST via
 * raw curl written by the model per prompt instructions — and the provenance
 * footer was then stamped by DISCOVERY heuristics on the runner (scan open bot
 * PRs for a placeholder; pick the newest bot review for a sha), which silently
 * missed whenever the heuristic's premise broke. This script replaces the raw
 * curl: it performs the exact same REST create call AND records the created
 * artifact to a ledger AT CREATION TIME, so the runner can stamp by id instead
 * of guessing.
 *
 * It does two things on a successful create:
 *   1. Appends an NDJSON record to a well-known ledger file (durable artifact,
 *      one line per created PR / review / comment).
 *   2. Prints a `::agentproto-artifact::{…}` marker line to stdout — the
 *      transport back to the runner: the `agentproto-run` driver harvests
 *      these out of the agent session's own output (the same channel the
 *      `provenance` output already rides) and surfaces them as the action's
 *      `artifacts` output.
 *
 * Usage (from the repo clone root, inside the box):
 *   node .github/agentproto-workflows/lib/deliver-artifact.mjs \
 *     --kind pr|review|comment \
 *     --url  <full api.github.com URL> \
 *     --body-file <path to a JSON payload file> \
 *     [--method POST|PUT] [--sha <reviewed sha>] [--ledger <path>]
 *
 * Env: GITHUB_TOKEN (required). AGENTPROTO_ARTIFACT_LEDGER overrides the ledger
 * path (default `.agentproto/artifacts.ndjson`).
 *
 * Exit code: 0 when the create landed (an `id` came back), 1 otherwise — so the
 * model can see the failure and retry, exactly as the raw-curl recipe told it
 * to. Never prints the token.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"
import {
  buildArtifactRecord,
  formatArtifactMarker,
  serializeLedgerLine,
} from "../../../scripts/lib/artifact-ledger.mjs"

const DEFAULT_LEDGER = ".agentproto/artifacts.ndjson"

/** Parse the flag args into an options object. Pure — exported for tests. */
export const parseArgs = (argv) => {
  const opts = { method: "POST" }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const take = () => argv[++i]
    switch (a) {
      case "--kind": opts.kind = take(); break
      case "--url": opts.url = take(); break
      case "--body-file": opts.bodyFile = take(); break
      case "--method": opts.method = (take() || "POST").toUpperCase(); break
      case "--sha": opts.sha = take(); break
      case "--ledger": opts.ledger = take(); break
      default:
        // Ignore unknown flags rather than aborting a cosmetic delivery aid.
        break
    }
  }
  return opts
}

/** Append one record to the NDJSON ledger, creating its directory. */
export const appendLedger = (ledgerPath, record) => {
  mkdirSync(dirname(ledgerPath), { recursive: true })
  appendFileSync(ledgerPath, serializeLedgerLine(record), "utf8")
}

async function main(argv) {
  const opts = parseArgs(argv)
  const token = (process.env.GITHUB_TOKEN ?? "").trim()
  if (!token) {
    console.error("deliver-artifact: GITHUB_TOKEN is not set — cannot deliver.")
    return 1
  }
  if (!opts.kind || !opts.url || !opts.bodyFile) {
    console.error("deliver-artifact: --kind, --url and --body-file are all required.")
    return 1
  }

  let body
  try {
    body = readFileSync(opts.bodyFile, "utf8")
  } catch (err) {
    console.error(`deliver-artifact: cannot read --body-file ${opts.bodyFile}: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  let res
  try {
    res = await fetch(opts.url, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body,
    })
  } catch (err) {
    console.error(`deliver-artifact: network error POSTing to GitHub: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // non-JSON body — leave json null, handled below
  }

  const record = buildArtifactRecord({ kind: opts.kind, response: json, sha: opts.sha })
  if (!res.ok || !record) {
    console.error(
      `deliver-artifact: create failed (status ${res.status}) — no artifact recorded: ${String(text).slice(0, 300)}`,
    )
    return 1
  }

  const ledgerPath = opts.ledger || (process.env.AGENTPROTO_ARTIFACT_LEDGER ?? "").trim() || DEFAULT_LEDGER
  try {
    appendLedger(ledgerPath, record)
  } catch (err) {
    // The stdout marker is the load-bearing transport; a ledger-file write
    // failure must not sink an otherwise-successful delivery.
    console.error(`deliver-artifact: ledger append to ${ledgerPath} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  }

  // The marker line the runner harvests — keep it on its OWN line, first.
  console.log(formatArtifactMarker(record))
  console.log(
    `deliver-artifact: created ${record.kind} id=${record.id}` +
      (record.number !== undefined ? ` number=${record.number}` : "") +
      (record.url ? ` url=${record.url}` : ""),
  )
  return 0
}

// Only run when invoked directly — importing for tests pulls the pure exports.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
