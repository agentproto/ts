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

// Extract every path the patch touches, from the patch's OWN headers rather
// than `git apply --numstat`. numstat reports only the DESTINATION of a
// rename/copy (`scripts/pwn.mjs -> docs/ok.md` reads as just `docs/ok.md`), so
// a scope check that trusts numstat can be bypassed by renaming a non-docs
// file into docs/ (or vice versa). Parsing both sides of `diff --git` /
// `---`/`+++` and rejecting rename/copy directives outright closes that hole.
const paths = new Set()
for (const line of patch.split('\n')) {
  let m
  if ((m = /^diff --git a\/(.+) b\/(.+)$/.exec(line))) {
    paths.add(m[1])
    paths.add(m[2])
  } else if ((m = /^--- a\/(.+)$/.exec(line))) {
    paths.add(m[1])
  } else if ((m = /^\+\+\+ b\/(.+)$/.exec(line))) {
    paths.add(m[1])
  } else if (/^(?:rename|copy) (?:from|to) /.test(line)) {
    throw new Error(`Claude Cloud patch uses a rename/copy directive (${line.trim()}) — not allowed in a docs-scope patch`)
  }
}

const allowed = (path) => path === 'README.md' || path.startsWith('docs/') || path.endsWith('/README.md')
const disallowed = [...paths].filter((path) => !allowed(path))
if (disallowed.length) throw new Error(`Claude Cloud patch escapes the docs scope: ${disallowed.join(', ')}`)

execFileSync('git', ['apply', '--whitespace=error-all'], options)
console.log(`Applied Claude Cloud documentation patch (${paths.size} file(s)).`)
