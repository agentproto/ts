#!/usr/bin/env node

const pr = process.env.PR_NUMBER
const base = process.env.BASE_REF
if (!pr || !base) throw new Error('PR_NUMBER and BASE_REF are required')

process.stdout.write(`Review pull request #${pr} against origin/${base}.

Inspect the full diff and the relevant surrounding code. This is read-only: do not edit, commit, push, post to GitHub, or call external services.

Your final response must be exactly one JSON object with no markdown fence or surrounding prose:
{"event":"APPROVE|REQUEST_CHANGES|COMMENT","body":"concise review with actionable findings"}

Use APPROVE only when there are no blocking findings, REQUEST_CHANGES for concrete blocking defects, and COMMENT when the review is useful but neither approval nor a blocking request is appropriate.
`)
