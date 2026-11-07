import { test } from 'node:test'
import assert from 'node:assert/strict'
import workflow from './entry.mjs'
import {
  reviewerModelFor,
  reviewerPlacementFor,
  reviewerTurnRetryFor,
  sandboxRefFor,
  workspaceCwdFor,
} from '../lib/sandbox-agent.mjs'

const prompt = (input) => workflow.steps[0].prompt({ input })

// ── host placement (default — unchanged behavior) ──────────────────────────

test('default placement (no reviewerSandbox, no repo) reviews via gh CLI', () => {
  const text = prompt({ prNumber: 42 })
  assert.match(text, /Your job: review PR #42 and post a structured GitHub review\./)
  assert.match(text, /gh pr review 42 --approve/)
  assert.match(text, /NEVER use `--comment` for a final verdict/)
  assert.doesNotMatch(text, /gh pr review 42 --comment/)
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
  assert.doesNotMatch(text, /git push/)
  assert.match(text, /agentic-changeset:/)
  assert.doesNotMatch(text, /gh pr review 7 --comment/)
  assert.doesNotMatch(text, /LOCAL run/)
})

test('reviewerSandbox without repo falls back to host (no clone target)', () => {
  const text = prompt({ prNumber: 7, reviewConfig: { reviewerSandbox: 'e2b' } })
  assert.doesNotMatch(text, /Phase 0: Workspace bootstrap/)
  assert.match(text, /gh pr review 7 --approve/)
  assert.doesNotMatch(text, /gh pr review 7 --comment/)
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

test('string form is unchanged: derived spec with hook + fallback passthrough (no adapter install — runtime auto-injects it)', () => {
  const spec = sandboxRefFor({ reviewerSandbox: 'e2b' }, 'review')
  assert.equal(spec.provider, 'e2b')
  assert.equal(spec.config.installPackages, undefined)
  assert.match(spec.config.setupCommands[0], ATTRIBUTION_HOOK)
  assert.deepEqual(spec.env.passthrough, ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN'])
  assert.equal(spec.reuse, undefined)
})

// ── reviewerModel (step `model` selector) ────────────────────────────────────

test('reviewerModelFor resolves reviewerModel from the config (global and per-verb)', () => {
  assert.equal(reviewerModelFor({ reviewerModel: 'claude-sonnet-5-5' }, 'review'), 'claude-sonnet-5-5')
  assert.equal(
    reviewerModelFor(
      { reviewerModel: 'global', commands: { review: { reviewerModel: 'per-verb' } } },
      'review',
    ),
    'per-verb',
  )
})

test('reviewerModelFor returns undefined for absent/blank reviewerModel (adapter default)', () => {
  for (const cfg of [{}, { reviewerModel: '' }, { reviewerModel: '   ' }, { reviewerModel: 42 }]) {
    assert.equal(reviewerModelFor(cfg, 'review'), undefined)
  }
})

test('the review step declares a model selector resolving reviewerModel from reviewConfig', () => {
  assert.equal(typeof workflow.steps[0].model, 'function')
  assert.equal(
    workflow.steps[0].model({ input: { reviewConfig: { reviewerModel: 'claude-sonnet-5-5' } } }),
    'claude-sonnet-5-5',
  )
  assert.equal(workflow.steps[0].model({ input: { reviewConfig: {} } }), undefined)
})

test('the claude-sdk reviewer config resolves adapter + model + env end to end', () => {
  const cfg = {
    reviewerAdapter: 'claude-sdk',
    reviewerModel: 'claude-sonnet-5-5',
    reviewerSandbox: 'e2b',
    reviewerSandboxEnv: ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN'],
  }
  const bindings = { input: { prNumber: 7, repo: 'agentproto/ts', reviewConfig: cfg } }
  assert.equal(workflow.steps[0].adapter(bindings), 'claude-sdk')
  assert.equal(workflow.steps[0].model(bindings), 'claude-sonnet-5-5')
  const spec = workflow.steps[0].sandbox(bindings)
  assert.deepEqual(spec.env.passthrough, ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN'])
  assert.equal(workflow.steps[0].cwd(bindings), '/home/user')
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
  // …but the derived hook is still merged in
  assert.match(spec.config.setupCommands[0], ATTRIBUTION_HOOK)
  assert.equal(spec.config.installPackages, undefined)
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
  assert.deepEqual(viaDefault.env.passthrough, ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN'])
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

// ── AGENTPROTO_JOIN passthrough (gated on the daemon process actually
//    having a value — see sandbox-agent.mjs's comment on why this can't be
//    unconditional like ANTHROPIC_API_KEY/GITHUB_TOKEN) ────────────────────

test('default passthrough omits AGENTPROTO_JOIN when this process has none (fork PR / no secret configured)', () => {
  assert.equal(process.env.AGENTPROTO_JOIN, undefined)
  const spec = sandboxRefFor({ reviewerSandbox: 'e2b' }, 'review')
  assert.deepEqual(spec.env.passthrough, ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN'])
})

test('default passthrough adds AGENTPROTO_JOIN when this process has a value to offer', () => {
  process.env.AGENTPROTO_JOIN = 'https://join.example/token'
  try {
    const spec = sandboxRefFor({ reviewerSandbox: 'e2b' }, 'review')
    assert.deepEqual(spec.env.passthrough, ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN', 'AGENTPROTO_JOIN'])
  } finally {
    delete process.env.AGENTPROTO_JOIN
  }
})

test('a configured reviewerSandboxEnv still wins its own list, but AGENTPROTO_JOIN is still appended when present — this repo\'s own opencode lane must not silently lose auto-join just because it pins reviewerSandboxEnv', () => {
  process.env.AGENTPROTO_JOIN = 'https://join.example/token'
  try {
    const spec = sandboxRefFor(
      { reviewerSandbox: 'e2b', reviewerSandboxEnv: ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN'] },
      'review',
    )
    assert.deepEqual(spec.env.passthrough, ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN', 'AGENTPROTO_JOIN'])
  } finally {
    delete process.env.AGENTPROTO_JOIN
  }
})

test('native object form without env.passthrough also picks up the gated AGENTPROTO_JOIN default', () => {
  process.env.AGENTPROTO_JOIN = 'https://join.example/token'
  try {
    const spec = sandboxRefFor({ reviewerSandbox: { provider: 'e2b' } }, 'review')
    assert.deepEqual(spec.env.passthrough, ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN', 'AGENTPROTO_JOIN'])
  } finally {
    delete process.env.AGENTPROTO_JOIN
  }
})

test('AGENTPROTO_JOIN set but blank/whitespace is treated as absent', () => {
  for (const blank of ['', '   ']) {
    process.env.AGENTPROTO_JOIN = blank
    try {
      const spec = sandboxRefFor({ reviewerSandbox: 'e2b' }, 'review')
      assert.deepEqual(spec.env.passthrough, ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN'])
    } finally {
      delete process.env.AGENTPROTO_JOIN
    }
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

// ── AGENTPROTO_JOIN_* metadata passthrough (SANDBOX-VISIBILITY-JOIN) ───────
// Same gate shape as AGENTPROTO_JOIN itself: only appended when both the
// join token AND that specific meta var are actually present on this
// process, so a fork PR / no-join run never grows this list, and a run that
// sets AGENTPROTO_JOIN but skips (say) AGENTPROTO_JOIN_LABELS still gets the
// others.

test('join metadata vars are omitted with no AGENTPROTO_JOIN (nothing to attach metadata to)', () => {
  process.env.AGENTPROTO_JOIN_NAME = 'ci-reviewer #1536'
  try {
    const spec = sandboxRefFor({ reviewerSandbox: 'e2b' }, 'review')
    assert.deepEqual(spec.env.passthrough, ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN'])
  } finally {
    delete process.env.AGENTPROTO_JOIN_NAME
  }
})

test('join metadata vars are appended alongside AGENTPROTO_JOIN when both are present', () => {
  process.env.AGENTPROTO_JOIN = 'https://join.example/token'
  process.env.AGENTPROTO_JOIN_NAME = 'ci-reviewer #1536'
  process.env.AGENTPROTO_JOIN_PROVIDER = 'e2b'
  process.env.AGENTPROTO_JOIN_SANDBOX_ID = 'sbx_abc123'
  process.env.AGENTPROTO_JOIN_LABELS = 'pr=1536,run=https://github.com/agentproto/ts/actions/runs/36438398607'
  try {
    const spec = sandboxRefFor({ reviewerSandbox: 'e2b' }, 'review')
    assert.deepEqual(spec.env.passthrough, [
      'ANTHROPIC_AUTH_TOKEN',
      'GITHUB_TOKEN',
      'AGENTPROTO_JOIN',
      'AGENTPROTO_JOIN_NAME',
      'AGENTPROTO_JOIN_PROVIDER',
      'AGENTPROTO_JOIN_SANDBOX_ID',
      'AGENTPROTO_JOIN_LABELS',
    ])
  } finally {
    delete process.env.AGENTPROTO_JOIN
    delete process.env.AGENTPROTO_JOIN_NAME
    delete process.env.AGENTPROTO_JOIN_PROVIDER
    delete process.env.AGENTPROTO_JOIN_SANDBOX_ID
    delete process.env.AGENTPROTO_JOIN_LABELS
  }
})

test('only the join metadata vars this process actually set are appended — partial config stays partial', () => {
  process.env.AGENTPROTO_JOIN = 'https://join.example/token'
  process.env.AGENTPROTO_JOIN_PROVIDER = 'e2b'
  try {
    const spec = sandboxRefFor({ reviewerSandbox: 'e2b' }, 'review')
    assert.deepEqual(spec.env.passthrough, [
      'ANTHROPIC_AUTH_TOKEN',
      'GITHUB_TOKEN',
      'AGENTPROTO_JOIN',
      'AGENTPROTO_JOIN_PROVIDER',
    ])
  } finally {
    delete process.env.AGENTPROTO_JOIN
    delete process.env.AGENTPROTO_JOIN_PROVIDER
  }
})

test('blank/whitespace join metadata vars are treated as absent, same as AGENTPROTO_JOIN itself', () => {
  process.env.AGENTPROTO_JOIN = 'https://join.example/token'
  process.env.AGENTPROTO_JOIN_NAME = '   '
  try {
    const spec = sandboxRefFor({ reviewerSandbox: 'e2b' }, 'review')
    assert.deepEqual(spec.env.passthrough, ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN', 'AGENTPROTO_JOIN'])
  } finally {
    delete process.env.AGENTPROTO_JOIN
    delete process.env.AGENTPROTO_JOIN_NAME
  }
})

// ── reviewerSandbox provider "auto" (computer fleet first, capped e2b overflow) ──

import { readFileSync } from 'node:fs'

const AUTO_ENV_KEYS = [
  'COMPUTER_CONTROLLER_URL',
  'AGENTPROTO_JOIN',
  'AGENTPROTO_JOIN_NAME',
  'AGENTPROTO_JOIN_PROVIDER',
  'AGENTPROTO_JOIN_SANDBOX_ID',
  'AGENTPROTO_JOIN_LABELS',
  'OPENCODE_GO_API_KEY',
  'OPENCODE_CONFIG_CONTENT',
  'AGENT_ALLOWED_METERED_MODELS',
]

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(AUTO_ENV_KEYS.map(k => [k, process.env[k]]))
  for (const k of AUTO_ENV_KEYS) delete process.env[k]
  Object.assign(process.env, vars)
  try {
    return fn()
  } finally {
    for (const k of AUTO_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

const reviewConfig = JSON.parse(
  readFileSync(new URL('../../agentic-review.json', import.meta.url), 'utf8'),
)
const autoSandbox = {
  provider: 'auto',
  lifecycle: { destroy_on: 'workspace-close' },
  config: {
    computer: {
      template: 'agentproto-workstation',
      cpus: 2,
      memoryMiB: 4096,
      fleetCapacityWaitMs: 240000,
      egress: ['github.com'],
    },
    overflow: {
      enabled: true,
      maxBoxesPerDay: 20,
      maxEurPerDay: 5,
      maxEurPerBox: 0.5,
      allowSecrets: true,
      secretAllowlist: [
        'OPENCODE_API_KEY',
        'GITHUB_TOKEN',
        'AGENTPROTO_JOIN',
        'AGENTPROTO_JOIN_NAME',
        'AGENTPROTO_JOIN_PROVIDER',
        'AGENTPROTO_JOIN_SANDBOX_ID',
        'AGENTPROTO_JOIN_LABELS',
      ],
    },
  },
}
const autoConfig = {
  reviewerSandbox: autoSandbox,
  reviewerSandboxEnv: ['OPENCODE_API_KEY', 'GITHUB_TOKEN'],
  cliVersion: '1.31.0',
}
const e2bConfig = {
  reviewerSandbox: { provider: 'e2b', lifecycle: { destroy_on: 'workspace-close' } },
  reviewerSandboxEnv: ['OPENCODE_API_KEY', 'GITHUB_TOKEN'],
  cliVersion: '1.31.0',
}

test('auto without COMPUTER_CONTROLLER_URL degrades to the plain e2b spec, byte for byte', () => {
  withEnv({}, () => {
    const spec = sandboxRefFor(autoConfig, 'review')
    assert.equal(JSON.stringify(spec), JSON.stringify(sandboxRefFor(e2bConfig, 'review')))
    assert.equal(spec.provider, 'e2b')
  })
})

test('auto with a blank COMPUTER_CONTROLLER_URL still degrades to e2b', () => {
  withEnv({ COMPUTER_CONTROLLER_URL: '   ' }, () => {
    assert.equal(sandboxRefFor(autoConfig, 'review').provider, 'e2b')
  })
})

test('auto degraded to e2b keeps join gating and reports e2b as the provider', () => {
  withEnv({ AGENTPROTO_JOIN: 'https://join.example/token' }, () => {
    const spec = sandboxRefFor(autoConfig, 'review')
    assert.equal(spec.provider, 'e2b')
    assert.equal(process.env.AGENTPROTO_JOIN_PROVIDER, 'e2b')
    assert.deepEqual(spec.env.passthrough, [
      'OPENCODE_API_KEY',
      'GITHUB_TOKEN',
      'AGENTPROTO_JOIN',
      'AGENTPROTO_JOIN_PROVIDER',
    ])
  })
})

test('auto with COMPUTER_CONTROLLER_URL keeps the auto spec with the computer config and overflow caps', () => {
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example' }, () => {
    const spec = sandboxRefFor(autoConfig, 'review')
    assert.equal(spec.provider, 'auto')
    assert.deepEqual(spec.lifecycle, { destroy_on: 'workspace-close' })
    assert.deepEqual(spec.config.computer, autoSandbox.config.computer)
    assert.equal(spec.config.computer.fleetCapacityWaitMs, 240000)
    assert.equal(spec.config.overflow.enabled, true)
    assert.equal(spec.config.overflow.maxEurPerBox, 0.5)
    assert.equal(spec.config.cliVersion, '1.31.0')
    assert.equal(spec.config.setupCommands.length, 1)
    assert.deepEqual(spec.env.passthrough, ['OPENCODE_API_KEY', 'GITHUB_TOKEN'])
    assert.equal(JSON.stringify(spec).includes('fleet.example'), false)
  })
})

test('auto narrows the overflow secret allowlist to the names this run actually passes', () => {
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example' }, () => {
    assert.deepEqual(sandboxRefFor(autoConfig, 'review').config.overflow.secretAllowlist, [
      'OPENCODE_API_KEY',
      'GITHUB_TOKEN',
    ])
  })
  withEnv(
    {
      COMPUTER_CONTROLLER_URL: 'https://fleet.example',
      AGENTPROTO_JOIN: 'https://join.example/token',
      AGENTPROTO_JOIN_NAME: 'ci-box',
    },
    () => {
      const spec = sandboxRefFor(autoConfig, 'review')
      assert.equal(process.env.AGENTPROTO_JOIN_PROVIDER, 'computer')
      assert.deepEqual(spec.env.passthrough, [
        'OPENCODE_API_KEY',
        'GITHUB_TOKEN',
        'AGENTPROTO_JOIN',
        'AGENTPROTO_JOIN_NAME',
        'AGENTPROTO_JOIN_PROVIDER',
      ])
      assert.deepEqual(spec.config.overflow.secretAllowlist, spec.env.passthrough)
    },
  )
})

test('auto never allowlists a passthrough name the config did not declare (the overflow then refuses)', () => {
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example' }, () => {
    const spec = sandboxRefFor(
      { ...autoConfig, reviewerSandboxEnv: ['OPENCODE_API_KEY', 'GITHUB_TOKEN', 'SOME_OTHER_SECRET'] },
      'review',
    )
    assert.equal(spec.env.passthrough.includes('SOME_OTHER_SECRET'), true)
    assert.equal(spec.config.overflow.secretAllowlist.includes('SOME_OTHER_SECRET'), false)
  })
})

test('a pre-set AGENTPROTO_JOIN_PROVIDER is not overwritten by the auto default', () => {
  withEnv(
    { COMPUTER_CONTROLLER_URL: 'https://fleet.example', AGENTPROTO_JOIN: 'x', AGENTPROTO_JOIN_PROVIDER: 'custom' },
    () => {
      sandboxRefFor(autoConfig, 'review')
      assert.equal(process.env.AGENTPROTO_JOIN_PROVIDER, 'custom')
    },
  )
})

test('the join provider default is gated on AGENTPROTO_JOIN: nothing is set or passed without it', () => {
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example' }, () => {
    const spec = sandboxRefFor(autoConfig, 'review')
    assert.equal(process.env.AGENTPROTO_JOIN_PROVIDER, undefined)
    assert.equal(spec.env.passthrough.includes('AGENTPROTO_JOIN_PROVIDER'), false)
  })
})

test('non-auto providers do not get a join provider default (join gating unchanged)', () => {
  withEnv({ AGENTPROTO_JOIN: 'https://join.example/token' }, () => {
    const spec = sandboxRefFor(e2bConfig, 'review')
    assert.equal(process.env.AGENTPROTO_JOIN_PROVIDER, undefined)
    assert.deepEqual(spec.env.passthrough, ['OPENCODE_API_KEY', 'GITHUB_TOKEN', 'AGENTPROTO_JOIN'])
  })
})

// ── reviewerPlacement: the placement ladder + turn-retry (the CI review lane) ──

const FLASH = 'opencode-go/deepseek-v4.1-flash'
const lifecycle = { destroy_on: 'workspace-close' }
const mergedPreset = name => ({ ...reviewConfig, ...reviewConfig.agentPresets[name] })
// Presets inherit the top-level ladder (toReviewConfig spreads the preset over
// the config), so the opencode presets are the ones that run on it.
const ladderPresets = Object.entries(reviewConfig.agentPresets ?? {})
  .filter(([, p]) => p.reviewerAdapter === 'opencode')
  .map(([name]) => [name, mergedPreset(name)])
const GO_ENV = { OPENCODE_GO_API_KEY: 'go-key', AGENT_ALLOWED_METERED_MODELS: FLASH }

test('agentic-review.json: one 3-rung ladder at the top level, inherited by every opencode preset', () => {
  assert.equal(ladderPresets.length, 5)
  assert.equal(reviewConfig.reviewerSandbox, undefined, 'a ladder is exclusive with reviewerSandbox')
  for (const [name, preset] of ladderPresets) {
    assert.equal(reviewConfig.agentPresets[name].reviewerPlacement, undefined, `${name} redeclares the ladder`)
    assert.equal(preset.reviewerSandbox, undefined, name)
    assert.deepEqual(preset.reviewerPlacement, reviewConfig.reviewerPlacement, name)
  }
  const { ladder } = reviewConfig.reviewerPlacement
  assert.deepEqual(
    ladder.map(r => r.sandbox.provider),
    ['computer', 'e2b', 'computer'],
  )
  assert.deepEqual(ladder.map(r => r.preflight), [['model-answers'], ['model-answers'], undefined])
  for (const rung of ladder) assert.deepEqual(rung.sandbox.lifecycle, lifecycle)
})

test('agentic-review.json: the only paid model anywhere in the ladders is the FLASH fallback rung', () => {
  const models = [reviewConfig, ...ladderPresets.map(([, p]) => p)].flatMap(c =>
    c.reviewerPlacement.ladder.map(r => r.model),
  )
  assert.deepEqual([...new Set(models)], [undefined, FLASH])
  assert.equal(reviewConfig.reviewerPlacement.ladder[2].model, FLASH)
  for (const [, p] of ladderPresets) assert.match(p.reviewerModel, /-free$/)
})

test('agentic-review.json: computer rungs ask for a distinct egress IP and the review egress set', () => {
  const { sandbox } = reviewConfig.reviewerPlacement.ladder[0]
  assert.equal(sandbox.config.egressIp, 'auto')
  assert.equal(sandbox.config.template, 'agentproto-workstation')
  assert.equal(sandbox.config.fleetCapacityWaitMs, 240000)
  assert.deepEqual(sandbox.config.egress.includes('github.com'), true)
  assert.deepEqual(reviewConfig.reviewerPlacement.ladder[2].sandbox, sandbox)
})

const TRANSIENT = ['rate-limit', 'upstream-5xx', 'no-output-stall']
const FREE_ROTATION = [
  { model: 'opencode/mimo-v2.6-flash-free' },
  { model: 'opencode/deepseek-v4.1-flash-free' },
  { model: 'opencode/glm-5.3-flash-free' },
]
const FULL_RETRY = {
  on: [...TRANSIENT, 'usage-limit'],
  maxRetries: 6,
  rotate: FREE_ROTATION,
  rotateOn: TRANSIENT,
  fallback: [{ model: FLASH }],
}
const { fallback: _paid, ...RETRY_NO_FALLBACK } = FULL_RETRY

test('agentic-review.json: reviewerTurnRetry keeps the box defaults and adds usage-limit with the FLASH fallback', () => {
  assert.deepEqual(reviewConfig.reviewerTurnRetry, FULL_RETRY)
  for (const cls of TRANSIENT) assert.equal(reviewConfig.reviewerTurnRetry.on.includes(cls), true, `${cls} kept`)
  assert.equal(reviewConfig.reviewerTurnRetry.maxRetries, 6)
  assert.equal(reviewConfig.agentPresets['claude-cloud'].reviewerPlacement, null)
  assert.equal(reviewConfig.agentPresets['claude-cloud'].reviewerTurnRetry, null)
})

test('agentic-review.json: every opencode preset with a ladder also keeps the transient classes and the FLASH fallback', () => {
  for (const [name] of ladderPresets) {
    const tr = mergedPreset(name).reviewerTurnRetry
    for (const cls of [...TRANSIENT, 'usage-limit']) assert.equal(tr.on.includes(cls), true, `${name}: ${cls}`)
    assert.deepEqual(tr.fallback, [{ model: FLASH }], name)
    assert.equal(tr.maxRetries, 6, name)
  }
})

test('ladder without a fleet URL: only the e2b rung survives, byte for byte the old e2b spec', () => {
  withEnv({}, () => {
    for (const cfg of [reviewConfig, ...ladderPresets.map(([name]) => mergedPreset(name))]) {
      const { ladder } = reviewerPlacementFor(cfg, 'review')
      assert.equal(ladder.length, 1)
      assert.deepEqual(ladder[0].preflight, ['model-answers'])
      const legacy = { ...cfg, reviewerPlacement: undefined, reviewerSandbox: { provider: 'e2b', lifecycle } }
      assert.equal(JSON.stringify(ladder[0].sandbox), JSON.stringify(sandboxRefFor(legacy, 'review')))
    }
  })
})

test('ladder with a fleet URL and the Go key + allowlist: computer, e2b, computer(FLASH)', () => {
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example', ...GO_ENV }, () => {
    const { ladder } = reviewerPlacementFor(reviewConfig, 'review')
    assert.deepEqual(
      ladder.map(r => [r.sandbox.provider, r.model]),
      [
        ['computer', undefined],
        ['e2b', undefined],
        ['computer', FLASH],
      ],
    )
    const goPassthrough = ['OPENCODE_API_KEY', 'GITHUB_TOKEN', 'OPENCODE_GO_API_KEY', 'OPENCODE_CONFIG_CONTENT']
    for (const rung of ladder) {
      assert.deepEqual(rung.sandbox.env.passthrough, goPassthrough)
      assert.equal(rung.sandbox.config.cliVersion, '1.31.0')
      assert.equal(rung.sandbox.config.setupCommands.length, 1)
      assert.deepEqual(rung.sandbox.lifecycle, lifecycle)
    }
    assert.equal(ladder[0].sandbox.config.egressIp, 'auto')
    assert.equal(ladder[0].sandbox.config.template, 'agentproto-workstation')
    assert.equal(JSON.stringify(ladder).includes('fleet.example'), false)
    assert.equal(JSON.stringify(ladder).includes('go-key'), false, 'only env NAMES are placed in the spec')
  })
})

test('AGENT_REVIEW_PLACEMENT=e2b moves the e2b rung first and keeps the other rungs after it in order', () => {
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example', AGENT_REVIEW_PLACEMENT: 'e2b', ...GO_ENV }, () => {
    const { ladder } = reviewerPlacementFor(reviewConfig, 'review')
    assert.deepEqual(
      ladder.map(r => [r.sandbox.provider, r.model]),
      [
        ['e2b', undefined],
        ['computer', undefined],
        ['computer', FLASH],
      ],
    )
  })
})

test('AGENT_REVIEW_PLACEMENT is ordered, case/space/comma tolerant, and unset or empty keeps the config order', () => {
  const order = () => reviewerPlacementFor(reviewConfig, 'review').ladder.map(r => r.sandbox.provider)
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example', AGENT_REVIEW_PLACEMENT: ' E2B , computer ', ...GO_ENV }, () => {
    assert.deepEqual(order(), ['e2b', 'computer', 'computer'])
  })
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example', AGENT_REVIEW_PLACEMENT: '   ', ...GO_ENV }, () => {
    assert.deepEqual(order(), ['computer', 'e2b', 'computer'])
  })
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example', ...GO_ENV }, () => {
    assert.deepEqual(order(), ['computer', 'e2b', 'computer'])
  })
})

test('AGENT_REVIEW_PLACEMENT never adds a rung: a provider the config has no rung for is ignored, and no fleet still drops the computer rungs', () => {
  withEnv({ AGENT_REVIEW_PLACEMENT: 'computer,e2b' }, () => {
    assert.deepEqual(reviewerPlacementFor(reviewConfig, 'review').ladder.map(r => r.sandbox.provider), ['e2b'])
  })
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example', AGENT_REVIEW_PLACEMENT: 'modal' }, () => {
    assert.deepEqual(reviewerPlacementFor(reviewConfig, 'review').ladder.map(r => r.sandbox.provider), ['computer', 'e2b'])
  })
})

test('ladder with a fleet URL but no allowlist entry: the paid rung and the paid fallback are dropped', () => {
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example', OPENCODE_GO_API_KEY: 'go-key' }, () => {
    const { ladder } = reviewerPlacementFor(reviewConfig, 'review')
    assert.deepEqual(ladder.map(r => r.sandbox.provider), ['computer', 'e2b'])
    for (const rung of ladder) assert.deepEqual(rung.sandbox.env.passthrough, ['OPENCODE_API_KEY', 'GITHUB_TOKEN'])
    assert.deepEqual(reviewerTurnRetryFor(reviewConfig, 'review'), RETRY_NO_FALLBACK)
    assert.equal(process.env.OPENCODE_CONFIG_CONTENT, undefined)
  })
})

test('the paid rung also needs the Go key, an allowlisted id alone is not enough', () => {
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example', AGENT_ALLOWED_METERED_MODELS: FLASH }, () => {
    const { ladder } = reviewerPlacementFor(reviewConfig, 'review')
    assert.deepEqual(ladder.map(r => r.sandbox.provider), ['computer', 'e2b'])
    assert.deepEqual(reviewerTurnRetryFor(reviewConfig, 'review'), RETRY_NO_FALLBACK)
  })
})

test('the allowlist is split on commas and whitespace and matched exactly', () => {
  withEnv(
    { COMPUTER_CONTROLLER_URL: 'https://fleet.example', OPENCODE_GO_API_KEY: 'k', AGENT_ALLOWED_METERED_MODELS: `x/y, ${FLASH}` },
    () => assert.equal(reviewerPlacementFor(reviewConfig, 'review').ladder.length, 3),
  )
  withEnv(
    { COMPUTER_CONTROLLER_URL: 'https://fleet.example', OPENCODE_GO_API_KEY: 'k', AGENT_ALLOWED_METERED_MODELS: `${FLASH}-x` },
    () => assert.equal(reviewerPlacementFor(reviewConfig, 'review').ladder.length, 2),
  )
})

test('with the Go key, OPENCODE_CONFIG_CONTENT points the Go provider at OPENCODE_GO_API_KEY and keeps existing config', () => {
  withEnv({ ...GO_ENV, OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: 'dark', provider: { other: { x: 1 } } }) }, () => {
    reviewerTurnRetryFor(reviewConfig, 'review')
    reviewerTurnRetryFor(reviewConfig, 'review')
    const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
    assert.equal(inline.theme, 'dark')
    assert.deepEqual(inline.provider.other, { x: 1 })
    assert.equal(inline.provider['opencode-go'].options.apiKey, '{env:OPENCODE_GO_API_KEY}')
    assert.equal(process.env.OPENCODE_API_KEY, undefined, 'the Zen key variable is never repointed')
  })
})

test('an unparseable inline OPENCODE_CONFIG_CONTENT is left untouched', () => {
  withEnv({ ...GO_ENV, OPENCODE_CONFIG_CONTENT: '{nope' }, () => {
    reviewerTurnRetryFor(reviewConfig, 'review')
    assert.equal(process.env.OPENCODE_CONFIG_CONTENT, '{nope')
  })
})

test('a ladder with no usable rung fails loudly instead of degrading to a host spawn', () => {
  withEnv({}, () => {
    const computerOnly = {
      reviewerPlacement: { ladder: [reviewConfig.reviewerPlacement.ladder[0]] },
      reviewerSandboxEnv: ['OPENCODE_API_KEY', 'GITHUB_TOKEN'],
    }
    assert.throws(() => reviewerPlacementFor(computerOnly, 'review'), /no placement rung is usable/)
  })
})

test('an opencode-go model is never routed on a non-opencode adapter', () => {
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example', ...GO_ENV }, () => {
    const claude = { ...reviewConfig, reviewerAdapter: 'claude-sdk' }
    assert.deepEqual(reviewerPlacementFor(claude, 'review').ladder.map(r => r.sandbox.provider), ['computer', 'e2b'])
    assert.deepEqual(reviewerTurnRetryFor(claude, 'review'), RETRY_NO_FALLBACK)
  })
})

test('join provider defaults to the first surviving rung', () => {
  withEnv({ AGENTPROTO_JOIN: 'https://join.example/token' }, () => {
    reviewerPlacementFor(reviewConfig, 'review')
    assert.equal(process.env.AGENTPROTO_JOIN_PROVIDER, 'e2b')
  })
  withEnv({ AGENTPROTO_JOIN: 'https://join.example/token', COMPUTER_CONTROLLER_URL: 'https://fleet.example' }, () => {
    const { ladder } = reviewerPlacementFor(reviewConfig, 'review')
    assert.equal(process.env.AGENTPROTO_JOIN_PROVIDER, 'computer')
    assert.equal(ladder[1].sandbox.env.passthrough.includes('AGENTPROTO_JOIN_PROVIDER'), true)
  })
})

test('reviewerTurnRetryFor: absent is undefined, null opts out, claude-cloud preset opts out', () => {
  assert.equal(reviewerTurnRetryFor({}, 'review'), undefined)
  assert.equal(reviewerTurnRetryFor({ reviewerTurnRetry: null }, 'review'), null)
  assert.equal(reviewerTurnRetryFor(mergedPreset('claude-cloud'), 'review'), null)
  assert.equal(reviewerPlacementFor(mergedPreset('claude-cloud'), 'review'), undefined)
})

test('reviewerPlacementFor is undefined without a ladder, and other verbs still get a box via sandboxRefFor', () => {
  assert.equal(reviewerPlacementFor({ reviewerSandbox: 'e2b' }, 'review'), undefined)
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example' }, () => {
    const spec = sandboxRefFor(reviewConfig, 'review')
    assert.equal(spec.provider, 'e2b')
    assert.equal(spec.config.computer, undefined)
  })
})

// ── the review step wires placement / turnRetry / sandbox / cwd ────────────────

const step = workflow.steps[0]
const bindings = (input, extra = {}) => ({ input: { prNumber: 7, repo: 'agentproto/ts', ...input }, ...extra })

test('step: a ladder config sets placement + turnRetry, no sandbox, cwd /home/user', () => {
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example', ...GO_ENV }, () => {
    const b = bindings({ reviewConfig })
    assert.equal(step.sandbox(b), undefined)
    assert.deepEqual(
      step.placement(b).ladder.map(r => r.sandbox.provider),
      ['computer', 'e2b', 'computer'],
    )
    assert.deepEqual(step.turnRetry(b), FULL_RETRY)
    assert.equal(step.cwd(b), '/home/user')
    const text = step.prompt(b)
    assert.match(text, /Phase 0: Workspace bootstrap/)
    assert.match(text, /deliver-artifact\.mjs/)
    assert.doesNotMatch(text, /gh pr review 7 --comment/)
  })
})

test('step: a legacy reviewerSandbox config keeps sandbox and no placement', () => {
  const b = bindings({ reviewConfig: { reviewerSandbox: 'e2b' } })
  assert.equal(step.sandbox(b).provider, 'e2b')
  assert.equal(step.placement(b), undefined)
  assert.equal(step.turnRetry(b), undefined)
})

test('step: placement "local" is a host spawn with no ladder, sandbox or paid fallback', () => {
  withEnv({ COMPUTER_CONTROLLER_URL: 'https://fleet.example', ...GO_ENV }, () => {
    const b = bindings({ placement: 'local', reviewConfig })
    assert.equal(step.sandbox(b), undefined)
    assert.equal(step.placement(b), undefined)
    assert.equal(step.turnRetry(b), undefined)
    assert.equal(step.cwd(b), undefined)
    assert.equal(process.env.OPENCODE_CONFIG_CONTENT, undefined)
  })
})

test('step: the ladder does not apply to a config with no reviewConfig (host)', () => {
  const b = { input: { prNumber: 7 } }
  assert.equal(step.placement(b), undefined)
  assert.equal(step.sandbox(b), undefined)
  assert.equal(step.turnRetry(b), undefined)
})
