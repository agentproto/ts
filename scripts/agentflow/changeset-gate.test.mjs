import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changesetVerdict } from './changeset-gate.mjs'

const cs = (file, text) => ({ file, text })

test('nothing publishable changed → ok, no changeset needed', () => {
  assert.equal(changesetVerdict(new Set(), []).ok, true)
})

test('publishable change with no branch changeset → blocked', () => {
  const v = changesetVerdict(new Set(['@agentproto/runtime']), [])
  assert.equal(v.ok, false)
  assert.match(v.problems[0], /no changeset on this branch for: @agentproto\/runtime/)
})

test('single block covering every changed package → ok', () => {
  const text = '---\n"@agentproto/runtime": minor\n"@agentproto/apps": minor\n---\n\nX.\n'
  const v = changesetVerdict(new Set(['@agentproto/runtime', '@agentproto/apps']), [cs('.changeset/a.md', text)])
  assert.deepEqual(v, { ok: true, touched: v.touched, problems: [] })
})

test('stacked blocks (pr-1505 shape) → blocked on both the shape and the missing package', () => {
  const text = '---\n"@agentproto/runtime": minor\n---\n\nA.\n\n---\n"@agentproto/apps": minor\n---\n\nB.\n'
  const v = changesetVerdict(new Set(['@agentproto/runtime', '@agentproto/apps']), [cs('.changeset/pr.md', text)])
  assert.equal(v.ok, false)
  assert.match(v.problems[0], /several frontmatter blocks/)
  assert.match(v.problems[1], /not in any changeset on this branch: @agentproto\/apps/)
})

test('coverage can be split across several changeset files', () => {
  const v = changesetVerdict(new Set(['@agentproto/runtime', '@agentproto/cli']), [
    cs('.changeset/a.md', '---\n"@agentproto/runtime": patch\n---\n\nA.\n'),
    cs('.changeset/b.md', '---\n"@agentproto/cli": patch\n---\n\nB.\n'),
  ])
  assert.equal(v.ok, true)
})
