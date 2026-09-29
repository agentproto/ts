#!/usr/bin/env node
/**
 * Split the workspace's test suites into N balanced CI shards.
 *
 *   node scripts/ci-test-shards.mjs --shard 2 --of 4
 *
 * Prints one `--filter=<package>` argument per line for that shard, ready to
 * splice into `turbo run test …` or `pnpm -r … test`. Every workspace package
 * under packages/** and adapters/** that defines a `test` script lands in
 * exactly one shard, so adding a package needs no CI edit: unknown packages
 * get DEFAULT_WEIGHT and are spread by the same greedy pass.
 *
 * Why weights: a handful of packages (runtime, vscode, worktree, cli) hold
 * most of the wall-clock, so an alphabetical split would leave one shard
 * running ten times longer than the rest. Weights are seconds from a local
 * forced `turbo run test` (2026-09-28) — only their relative order matters,
 * and a stale entry costs balance, never correctness.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_WEIGHT = 9 // median test-task duration across the workspace

export const WEIGHTS = {
  '@agentproto/runtime': 324,
  'agentproto-vscode': 201,
  '@agentproto/worktree': 189,
  '@agentproto/cli': 152,
  '@agentproto/pair-client': 77,
  '@agentproto/corpus-cli': 54,
  '@agentproto/adapter-mastra-agent': 39,
  '@agentproto/workflow-mastra': 33,
  '@agentproto/storage-github': 26,
  '@agentproto/apps': 26,
  '@agentproto/driver-agent-cli': 25,
  '@agentproto/corpus': 23,
  '@agentproto/workflow-runtime': 22,
}

/**
 * Longest-processing-time-first greedy partition. Deterministic: ties on
 * weight break by name, ties on shard load break by lowest shard index.
 *
 * @param {string[]} names
 * @param {number} count
 * @param {Record<string, number>} [weights]
 * @returns {string[][]} `count` shards, each sorted by name
 */
export function partition(names, count, weights = WEIGHTS) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be a positive integer (got ${count})`)
  const weightOf = (n) => weights[n] ?? DEFAULT_WEIGHT
  const ordered = [...new Set(names)].sort((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b))
  const shards = Array.from({ length: count }, () => ({ load: 0, names: [] }))
  for (const name of ordered) {
    const lightest = shards.reduce((best, s) => (s.load < best.load ? s : best))
    lightest.names.push(name)
    lightest.load += weightOf(name)
  }
  return shards.map((s) => s.names.sort())
}

/** Workspace packages the CI gate covers (packages/** + adapters/**) that define a `test` script. */
export function listTestedPackages(root) {
  const raw = execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  })
  const covered = ['packages', 'adapters'].map((d) => join(root, d) + sep)
  return JSON.parse(raw)
    .filter((p) => p.name && p.path && covered.some((c) => p.path.startsWith(c)))
    .filter((p) => {
      const manifest = join(p.path, 'package.json')
      return existsSync(manifest) && Boolean(JSON.parse(readFileSync(manifest, 'utf8')).scripts?.test)
    })
    .map((p) => p.name)
}

function main(argv) {
  const arg = (flag) => {
    const i = argv.indexOf(flag)
    return i === -1 ? undefined : Number.parseInt(argv[i + 1], 10)
  }
  const shard = arg('--shard')
  const of = arg('--of')
  if (!Number.isInteger(shard) || !Number.isInteger(of) || shard < 1 || shard > of) {
    console.error('usage: ci-test-shards.mjs --shard <1..N> --of <N>')
    process.exit(2)
  }
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
  const names = listTestedPackages(root)
  if (names.length === 0) {
    console.error('ci-test-shards: found no workspace packages with a test script — refusing to emit an empty shard')
    process.exit(1)
  }
  for (const name of partition(names, of)[shard - 1]) console.log(`--filter=${name}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
