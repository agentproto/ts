#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const repo = process.env.GITHUB_REPOSITORY
const pr = process.env.PR_NUMBER
if (!file || !repo || !pr) throw new Error('usage: post-cloud-review.mjs <result-file>; GITHUB_REPOSITORY and PR_NUMBER are required')

const raw = readFileSync(file, 'utf8').trim().replace(/^```(?:json)?\s*\n?|\n?```$/g, '')
const start = raw.indexOf('{')
const end = raw.lastIndexOf('}')
if (start < 0 || end < start) throw new Error('Claude Cloud did not return a JSON review object')
const review = JSON.parse(raw.slice(start, end + 1))
if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(review.event)) throw new Error(`invalid review event: ${review.event}`)
if (typeof review.body !== 'string' || review.body.trim().length < 20) throw new Error('review body is missing or too short')

const head = execFileSync('gh', ['pr', 'view', pr, '--repo', repo, '--json', 'headRefOid', '--jq', '.headRefOid'], {
  encoding: 'utf8',
}).trim()
const response = execFileSync('gh', ['api', '--method', 'POST', `repos/${repo}/pulls/${pr}/reviews`, '--input', '-'], {
  encoding: 'utf8',
  input: JSON.stringify({ body: review.body.trim(), event: review.event, commit_id: head }),
})
const posted = JSON.parse(response)
console.log(`Claude Cloud review posted: ${posted.html_url || posted.id}`)
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(process.env.GITHUB_OUTPUT, `posted=true\nreview_id=${posted.id || ''}\n`)
}
