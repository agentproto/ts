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
const paths = execFileSync('git', ['apply', '--numstat'], options)
  .split('\n')
  .filter(Boolean)
  .map((line) => line.split('\t').slice(2).join('\t'))

const allowed = (path) => path === 'README.md' || path.startsWith('docs/') || path.endsWith('/README.md')
const disallowed = paths.filter((path) => !allowed(path))
if (disallowed.length) throw new Error(`Claude Cloud patch escapes the docs scope: ${disallowed.join(', ')}`)

execFileSync('git', ['apply', '--whitespace=error-all'], options)
console.log(`Applied Claude Cloud documentation patch (${paths.length} file(s)).`)
