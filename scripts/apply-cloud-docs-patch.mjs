#!/usr/bin/env node

/** Validate and apply the unified diff returned by a Claude Code Cloud docs run. */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const patchFile = process.argv[2]
if (!patchFile) throw new Error('usage: apply-cloud-docs-patch.mjs <patch-file>')
const output = readFileSync(patchFile, 'utf8').trim()
if (output === 'NO_CHANGES') {
  console.log('Claude Cloud found no documentation drift.')
  process.exit(0)
}
if (!output.startsWith('diff --git ')) throw new Error('Claude Cloud output is neither NO_CHANGES nor a unified git diff')
const patch = output + '\n'

const options = { cwd: process.cwd(), input: patch, encoding: 'utf8' }
execFileSync('git', ['apply', '--check'], options)

// Reject rename/copy directives outright: `--numstat` reports only the
// DESTINATION of a rename/copy (`scripts/pwn.mjs -> docs/ok.md` reads as just
// `docs/ok.md`), so a scope check that trusts it can be bypassed by moving a
// non-docs file into docs/ (or vice versa). The docs lane never needs a
// rename, so refusing them is the simplest airtight rule.
if (/^(?:rename|copy) (?:from|to) /m.test(patch)) {
  throw new Error('Claude Cloud patch uses a rename/copy directive — not allowed in a docs-scope patch')
}

// Paths come from `--numstat -z`: NUL-delimited and UNQUOTED. Parsing the
// patch's own `diff --git`/`---`/`+++` headers instead is a hole — git
// C-quotes any path containing a quote, a backslash, or non-ASCII bytes
// (e.g. `+++ "b/scripts/\303\251.mjs"`), so a naive header regex never sees
// such a file, `disallowed` stays empty, and a non-docs file slips through.
const paths = execFileSync('git', ['apply', '--numstat', '-z'], options)
  .split('\0')
  .filter(Boolean)
  .map((record) => record.split('\t').slice(2).join('\t'))

const allowed = (path) => path === 'README.md' || path.startsWith('docs/') || path.endsWith('/README.md')
const disallowed = paths.filter((path) => !allowed(path))
if (disallowed.length) throw new Error(`Claude Cloud patch escapes the docs scope: ${disallowed.join(', ')}`)

execFileSync('git', ['apply', '--whitespace=error-all'], options)
console.log(`Applied Claude Cloud documentation patch (${paths.length} file(s)).`)
