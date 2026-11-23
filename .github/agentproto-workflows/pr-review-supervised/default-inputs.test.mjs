// Behavioural guard for the opt-in: with the workflow's DEFAULT inputs (no
// `autofix`) no fix step may be scheduled and CI must not commit fixes. Only
// the default export of entry.mjs and ci.yml are read, both of which exist on
// main, so on the pre-opt-in code this fails by ASSERTION (a fix is planned),
// not by a missing import.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import workflow from './entry.mjs'

const defaults = Object.fromEntries(
  Object.entries(workflow.inputs).map(([k, v]) => [k, v.default]),
)

const allIds = (steps, out = []) => {
  for (const s of steps) {
    out.push(s.id)
    if (Array.isArray(s.steps)) allIds(s.steps, out)
  }
  return out
}

// Step ids scheduled for `input`. Only a top-level branch keyed on `$input.*`
// (the opt-in gate) is resolved, with the exclusive-branch arm bodies of
// compileExclusiveBranch; every other step counts as scheduled (conservative).
const scheduled = (input) => {
  const steps = workflow.steps
  const out = []
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const gate = s.kind === 'branch' && s.branches.some((b) => b.when.startsWith('$input.'))
    if (!gate) {
      out.push(...allIds([s]))
      continue
    }
    const idx = (id) => steps.findIndex((x) => x.id === id)
    const hit = s.branches.find((b) => {
      const [ref, , lit] = b.when.split(/\s+(==)\s+/)
      return String(input[ref.replace('$input.', '')]) === lit
    })
    const start = idx(hit ? hit.next : s.default)
    const starts = [...s.branches.map((b) => idx(b.next)), idx(s.default)].sort((a, b) => a - b)
    const end = starts.find((n) => n > start) ?? steps.length
    out.push(s.id, ...allIds(steps.slice(start, end)))
    i = steps.length // arms cover the rest of the list
  }
  return out
}

test('default inputs schedule no fix step', () => {
  const ids = scheduled(defaults)
  assert.ok(!ids.includes('fix'), `a fix step is scheduled without opt-in: ${ids.join(', ')}`)
})

test('CI does not commit the fixer working tree without the opt-in', () => {
  const ci = readFileSync(new URL('../../workflows/ci.yml', import.meta.url), 'utf8')
  const at = ci.indexOf('- name: Commit supervised review fixes')
  assert.ok(at > 0)
  const cond = ci.slice(at, ci.indexOf('continue-on-error', at))
  assert.match(cond, /AGENTFLOW_AUTOFIX == 'true'/)
  assert.match(cond, /agentflow:autofix/)
})
