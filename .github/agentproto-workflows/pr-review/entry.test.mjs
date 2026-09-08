import { test } from 'node:test'
import assert from 'node:assert/strict'
import workflow from './entry.mjs'
import { sandboxRefFor, workspaceCwdFor } from '../lib/sandbox-agent.mjs'

const prompt = (input) => workflow.steps[0].prompt({ input })

// ── host placement (default — unchanged behavior) ──────────────────────────

test('default placement (no reviewerSandbox, no repo) reviews via gh CLI', () => {
  const text = prompt({ prNumber: 42 })
  assert.match(text, /Your job: review PR #42 and post a structured GitHub review\./)
  assert.match(text, /gh pr review 42 --comment/)
  assert.doesNotMatch(text, /curl -sS -X POST/)
  assert.doesNotMatch(text, /LOCAL run/)
  assert.match(text, /Write a changeset/)
})

// ── sandbox placement (unchanged behavior) ──────────────────────────────────

test('reviewerSandbox + repo selects sandbox (shared delivery helper) delivery', () => {
  const text = prompt({
    prNumber: 7,
    repo: 'agentproto/ts',
    reviewConfig: { reviewerSandbox: 'e2b' },
  })
  assert.match(text, /Phase 0: Workspace bootstrap/)
  // Sandbox delivery now routes through the shared delivery+ledger helper
  // (records the review to the artifact ledger) instead of raw curl.
  assert.match(text, /deliver-artifact\.mjs/)
  assert.match(text, /--kind review/)
  assert.doesNotMatch(text, /gh pr review 7 --comment/)
  assert.doesNotMatch(text, /LOCAL run/)
})

test('reviewerSandbox without repo falls back to host (no clone target)', () => {
  const text = prompt({ prNumber: 7, reviewConfig: { reviewerSandbox: 'e2b' } })
  assert.doesNotMatch(text, /Phase 0: Workspace bootstrap/)
  assert.match(text, /gh pr review 7 --comment/)
})

// ── local placement (new) ───────────────────────────────────────────────────

test('placement "local" never references gh, curl, or changesets', () => {
  const text = prompt({ placement: 'local' })
  assert.doesNotMatch(text, /\bgh pr review\b/)
  assert.doesNotMatch(text, /curl -sS/)
  assert.doesNotMatch(text, /Write a changeset/)
  assert.doesNotMatch(text, /\.changeset\/pr-/)
})

test('placement "local" runs without a prNumber and reviews the branch diff', () => {
  const text = prompt({ placement: 'local', baseRef: 'main' })
  assert.match(text, /LOCAL pre-push check/)
  assert.match(text, /git diff origin\/main\.\.\.HEAD/)
})

test('placement "local" instructs the agent to emit a single JSON verdict as its final message', () => {
  const text = prompt({ placement: 'local' })
  assert.match(text, /"conclusion": "approve" \| "request_changes"/)
  assert.match(text, /LAST thing you output/)
  assert.match(text, /no markdown fences, no prose/)
})

test('placement "local" wins even when reviewerSandbox + repo are also set', () => {
  const text = prompt({
    placement: 'local',
    prNumber: 7,
    repo: 'agentproto/ts',
    reviewConfig: { reviewerSandbox: 'e2b' },
  })
  assert.doesNotMatch(text, /Phase 0: Workspace bootstrap/)
  assert.doesNotMatch(text, /curl -sS -X POST/)
  assert.match(text, /LOCAL pre-push check/)
})

test('placement "local" forces the step to a HOST spawn (sandbox/cwd undefined) even when reviewConfig sets reviewerSandbox', () => {
  const bindings = {
    input: { placement: 'local', reviewConfig: { reviewerSandbox: 'e2b' } },
  }
  assert.equal(workflow.steps[0].sandbox(bindings), undefined)
  assert.equal(workflow.steps[0].cwd(bindings), undefined)
})

test('non-local placement still resolves sandbox/cwd from reviewConfig (unchanged behavior)', () => {
  const bindings = {
    input: { prNumber: 7, repo: 'agentproto/ts', reviewConfig: { reviewerSandbox: 'e2b' } },
  }
  assert.notEqual(workflow.steps[0].sandbox(bindings), undefined)
  assert.equal(workflow.steps[0].cwd(bindings), '/home/user')
})

// ── declared inputs ──────────────────────────────────────────────────────────

test('placement input defaults to "host" and prNumber defaults to 0', () => {
  assert.equal(workflow.inputs.placement.default, 'host')
  assert.equal(workflow.inputs.prNumber.default, 0)
})

// ── sandboxRefFor: native object spec (reviewerSandbox as a SandboxSpec) ────

const ATTRIBUTION_HOOK = /Strip AI-attribution trailers/

test('string form is unchanged: derived spec with adapter install + hook + fallback passthrough', () => {
  const spec = sandboxRefFor({ reviewerSandbox: 'e2b' }, 'review')
  assert.equal(spec.provider, 'e2b')
  assert.deepEqual(spec.config.installPackages, [
    '@agentproto/adapter-claude-code@latest',
    '@anthropic-ai/claude-code@latest',
  ])
  assert.match(spec.config.setupCommands[0], ATTRIBUTION_HOOK)
  assert.deepEqual(spec.env.passthrough, ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN'])
  assert.equal(spec.reuse, undefined)
})

test('native object spec is used verbatim as the base, with defaults merged under it', () => {
  const spec = sandboxRefFor(
    {
      reviewerSandbox: {
        provider: 'e2b',
        config: { machine: '4vcpu-8gb' },
        env: { passthrough: ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN'], EXTRA: 'kept' },
        lifecycle: { onStop: 'snapshot' },
        reuse: true,
      },
    },
    'review',
  )
  assert.equal(spec.provider, 'e2b')
  // object config keys win over derived defaults…
  assert.equal(spec.config.machine, '4vcpu-8gb')
  // …but derived install + hook are still merged in (product does not auto-inject yet)
  assert.match(spec.config.setupCommands[0], ATTRIBUTION_HOOK)
  assert.deepEqual(spec.config.installPackages, [
    '@agentproto/adapter-claude-code@latest',
    '@anthropic-ai/claude-code@latest',
  ])
  // other top-level keys carried through untouched — nothing invented
  assert.deepEqual(spec.lifecycle, { onStop: 'snapshot' })
  assert.equal(spec.reuse, true)
  // env keys kept, passthrough honored from the object itself
  assert.deepEqual(spec.env.passthrough, ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN'])
  assert.equal(spec.env.EXTRA, 'kept')
})

test('native object without env.passthrough falls back to reviewerSandboxEnv then default', () => {
  const viaCfg = sandboxRefFor(
    { reviewerSandbox: { provider: 'e2b' }, reviewerSandboxEnv: ['MY_TOKEN'] },
    'review',
  )
  assert.deepEqual(viaCfg.env.passthrough, ['MY_TOKEN'])
  const viaDefault = sandboxRefFor({ reviewerSandbox: { provider: 'e2b' } }, 'review')
  assert.deepEqual(viaDefault.env.passthrough, ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN'])
})

test('native object passthrough beats reviewerSandboxEnv', () => {
  const spec = sandboxRefFor(
    {
      reviewerSandbox: { provider: 'e2b', env: { passthrough: ['OBJ_TOKEN'] } },
      reviewerSandboxEnv: ['CFG_TOKEN'],
    },
    'review',
  )
  assert.deepEqual(spec.env.passthrough, ['OBJ_TOKEN'])
})

test('cliVersion pin applies to the native object form too (unless the object overrides it)', () => {
  const pinned = sandboxRefFor(
    { reviewerSandbox: { provider: 'e2b' }, cliVersion: '1.2.3' },
    'review',
  )
  assert.equal(pinned.config.cliVersion, '1.2.3')
  const overridden = sandboxRefFor(
    { reviewerSandbox: { provider: 'e2b', config: { cliVersion: '9.9.9' } }, cliVersion: '1.2.3' },
    'review',
  )
  assert.equal(overridden.config.cliVersion, '9.9.9')
})

test('empty/invalid reviewerSandbox still resolves to host (no spec, no cwd)', () => {
  for (const reviewerSandbox of [undefined, '', '   ', {}, { provider: '  ' }, [], null]) {
    assert.equal(sandboxRefFor({ reviewerSandbox }, 'review'), undefined)
    assert.equal(workspaceCwdFor({ reviewerSandbox }, 'review'), undefined)
  }
})

test('native object spec still selects /home/user as the workspace cwd', () => {
  assert.equal(workspaceCwdFor({ reviewerSandbox: { provider: 'e2b' } }, 'review'), '/home/user')
  const bindings = {
    input: { prNumber: 7, repo: 'agentproto/ts', reviewConfig: { reviewerSandbox: { provider: 'e2b' } } },
  }
  assert.notEqual(workflow.steps[0].sandbox(bindings), undefined)
  assert.equal(workflow.steps[0].cwd(bindings), '/home/user')
})
