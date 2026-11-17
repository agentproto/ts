/**
 * The agent lanes of the release workflow must not outlive their step: an
 * OpenCode run that kept editing docs after its step timed out is what made
 * "Open docs PR" fail on release run 44007187073. These tests drive real
 * processes: a child that ignores SIGTERM and a grandchild that would write a
 * marker file later, which is what an orphaned agent does to the checkout.
 *
 * Run: node --test scripts/lib/bounded-child.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { DEFAULT_DEADLINE_MINUTES, agentDeadlineMs, runBoundedChild } from './bounded-child.mjs'

const NODE = process.execPath

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-child-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Source of a grandchild that ignores SIGTERM and writes `marker` after `ms`. */
function lateWriter(marker, ms) {
  return `process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late edit'), ${ms})`
}

test('passes stdin through and returns the child output and exit code', async () => {
  const result = await runBoundedChild(
    NODE,
    ['-e', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(s.toUpperCase());process.stderr.write('warn');process.exit(3)})"],
    { input: 'prompt', deadlineMs: 10_000 },
  )
  assert.equal(result.stdout, 'PROMPT')
  assert.equal(result.stderr, 'warn')
  assert.equal(result.code, 3)
  assert.equal(result.timedOut, false)
})

test('past the deadline, the whole group is stopped, grandchildren included', async (t) => {
  const marker = join(scratch(t), 'late-edit')
  // The child ignores SIGTERM and keeps running; its grandchild would write
  // the marker 1.5 s in, long after the 200 ms deadline.
  const childSource = [
    "process.on('SIGTERM', () => {})",
    `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(lateWriter(marker, 1500))}], { stdio: 'ignore' })`,
    'setInterval(() => {}, 1000)',
  ].join(';')

  const started = Date.now()
  const result = await runBoundedChild(NODE, ['-e', childSource], { deadlineMs: 200, graceMs: 200 })
  assert.equal(result.timedOut, true)
  assert.equal(result.signal, 'SIGKILL', 'the SIGTERM-ignoring child is escalated to SIGKILL')
  assert.ok(Date.now() - started < 1400, 'returns once the group is gone, not when the agent decides to stop')

  await sleep(2000)
  assert.equal(existsSync(marker), false, 'a grandchild survived the deadline and kept writing')
})

test('a grandchild left behind by a child that exits normally is swept too', async (t) => {
  const marker = join(scratch(t), 'late-edit')
  const childSource = [
    `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(lateWriter(marker, 800))}], { stdio: 'ignore' }).unref()`,
    "process.stdout.write('done')",
  ].join(';')

  const result = await runBoundedChild(NODE, ['-e', childSource], { deadlineMs: 10_000 })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'done')
  assert.equal(result.timedOut, false)

  await sleep(1500)
  assert.equal(existsSync(marker), false, 'a grandchild outlived its lane and kept writing')
})

test('a command that cannot be spawned rejects', async () => {
  await assert.rejects(runBoundedChild('agentproto-no-such-binary', [], { deadlineMs: 1000 }), { code: 'ENOENT' })
})

test('the deadline needs to be positive', () => {
  assert.throws(() => runBoundedChild(NODE, ['-e', ''], {}), /positive deadlineMs/)
})

test('AGENT_DEADLINE_MINUTES: default, override, and bad values fall back to the default', () => {
  const warnings = []
  const warn = (line) => warnings.push(line)
  const fallback = DEFAULT_DEADLINE_MINUTES * 60_000
  assert.equal(agentDeadlineMs({}, warn), fallback)
  assert.equal(agentDeadlineMs({ AGENT_DEADLINE_MINUTES: '' }, warn), fallback)
  assert.equal(agentDeadlineMs({ AGENT_DEADLINE_MINUTES: '2.5' }, warn), 150_000)
  assert.equal(warnings.length, 0)
  assert.equal(agentDeadlineMs({ AGENT_DEADLINE_MINUTES: '0' }, warn), fallback)
  assert.equal(agentDeadlineMs({ AGENT_DEADLINE_MINUTES: 'soon' }, warn), fallback)
  assert.equal(warnings.length, 2)
  assert.match(warnings[1], /"soon"/)
})

// The deadline only helps if it fires before the runner cuts the step: once
// the step's timeout-minutes is hit, the script is orphaned along with its
// agent. Every release.yml step running a local agent lane must leave room
// for the deadline plus the SIGTERM grace period.
test('every local agent lane step in release.yml outlasts the lane deadline', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
  assert.doesNotMatch(workflow, /AGENT_DEADLINE_MINUTES/, 'release.yml overrides the deadline: compare the steps against that value instead')
  const steps = workflow.split(/\n(?=      - name: )/)
  const lanes = steps.filter((step) => /\n        run: node scripts\/(docs-check|release-notes)\.mjs\s*\n/.test(`${step}\n`))
  assert.ok(lanes.length >= 6, `expected the 3 docs + 3 notes local lanes, found ${lanes.length}`)
  for (const step of lanes) {
    const name = step.match(/- name: (.*)/)[1]
    const timeout = Number(step.match(/\n        timeout-minutes: (\d+)/)?.[1])
    assert.ok(timeout > DEFAULT_DEADLINE_MINUTES + 1, `${name}: timeout-minutes ${timeout} leaves no room for the ${DEFAULT_DEADLINE_MINUTES}-minute lane deadline`)
  }
})
