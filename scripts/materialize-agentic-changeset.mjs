#!/usr/bin/env node
/**
 * Materialize the changeset the sandboxed reviewer handed over as a PR
 * comment, unless the branch already carries that file or already ADDS
 * changesets declaring every package it names. Called by ci.yml's
 * "Commit changeset (if written by reviewer)" step.
 *
 * Before this, the step only skipped when the SAME path existed, so an
 * author's own changeset for the same packages got a duplicate bot one on
 * every review cycle, re-added even after the author deleted it
 * (agentproto/ts#2448, #2449).
 *
 * Usage: node scripts/materialize-agentic-changeset.mjs <comment-file> [baseRef]
 * Never fails the step: every error is logged and the script exits 0.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { changesetCovered, parseAgenticChangesetComment } from './check-changesets.mjs'

const [commentFile, baseRef = 'origin/main'] = process.argv.slice(2)
const log = (msg) => console.log(`agentic-changeset: ${msg}`)

/** Changesets the branch adds since `base`, minus `exclude`; null when git fails. */
function addedChangesets(base, exclude) {
  try {
    const out = execFileSync('git', ['diff', '--diff-filter=A', '--name-only', `${base}...HEAD`, '--', '.changeset/*.md'], {
      encoding: 'utf8',
    })
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((path) => path && path !== '.changeset/README.md' && path !== exclude)
  } catch {
    return null
  }
}

try {
  const proposal = parseAgenticChangesetComment(readFileSync(commentFile, 'utf8'))
  if (!proposal) {
    log('marker found but no fenced block, ignoring')
  } else if (existsSync(proposal.path)) {
    log(`${proposal.path} already on the branch, keeping it`)
  } else {
    const added = addedChangesets(baseRef, proposal.path)
    if (added !== null && changesetCovered(proposal.md, added.map((path) => readFileSync(path, 'utf8')))) {
      log(`the branch already adds ${added.join(', ')} covering every proposed package, not adding ${proposal.path}`)
    } else {
      if (added === null) log(`could not list changesets added since ${baseRef}, materializing anyway`)
      writeFileSync(proposal.path, proposal.md)
      log(`materialized ${proposal.path} from the reviewer comment`)
    }
  }
} catch (err) {
  log(`skipped (${err instanceof Error ? err.message : String(err)})`)
}
