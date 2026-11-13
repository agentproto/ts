// Credential rotation of the agentproto-run action: the pure helpers, the
// run-with-rotation.mjs loop (driven against a fake driver), and the wiring
// that makes the reviewer lanes use it.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  classifyCredentialFailure,
  errorLinesFromText,
  parseCredentialLadder,
  resolveCredentialRungs,
  reviewConfigForRung,
} from "./credential-rotation.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..", "..", "..")
const GO_FLASH = "opencode-go/deepseek-v4.1-flash"
const ZEN_FREE = "opencode/deepseek-v4.1-flash-free"

// Verbatim from the 2026-11-13 runs (ts 43453818189, studio 43451672064).
const FREE_CAP =
  "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"

test("classifyCredentialFailure: quota and credit exhaustion rotate, other failures do not", () => {
  assert.equal(classifyCredentialFailure([FREE_CAP]), "usage-limit")
  assert.equal(classifyCredentialFailure(["AI_APICallError: Go usage limit exceeded"]), "usage-limit")
  assert.equal(classifyCredentialFailure(["You've hit your weekly limit · resets Mon"]), "usage-limit")
  assert.equal(classifyCredentialFailure(["429 You exceeded your current quota, please check your plan"]), "usage-limit")
  assert.equal(classifyCredentialFailure(["Insufficient balance on this account"]), "credit-exhausted")
  assert.equal(classifyCredentialFailure(["Your credit balance is too low to access the API"]), "credit-exhausted")
  assert.equal(classifyCredentialFailure(["status: 402 Payment Required"]), "credit-exhausted")
  // A usage cap anywhere wins over a credit line.
  assert.equal(classifyCredentialFailure(["insufficient credits", FREE_CAP]), "usage-limit")
  for (const notOurs of [
    "session sess_ed091a23 produced an empty turn, no assistant output or tool call (commonly an auth failure or an invalid model id)",
    "Invalid credential",
    "401 Unauthorized",
    "429 Too Many Requests: rate limit, retry after 30s",
    "503 upstream overloaded",
    "maximum context length exceeded",
  ]) {
    assert.equal(classifyCredentialFailure([notOurs]), undefined, notOurs)
  }
  assert.equal(classifyCredentialFailure([]), undefined)
  assert.equal(classifyCredentialFailure(undefined), undefined)
})

test("errorLinesFromText: adapter [error] lines, ANSI stripped, prompt sections skipped", () => {
  const agentOutput = [
    "── opencode agent session sess_32c657eb (cwd /home/user) ──",
    `\x1b[31m[error] ${FREE_CAP}\x1b[0m`,
    "\x1b[2m  timestamp=… level=ERROR message=\"stream error\"\x1b[0m",
  ].join("\n")
  assert.deepEqual(errorLinesFromText(agentOutput), [FREE_CAP])

  const exported = [
    "### 🧑 User",
    "Your previous review (for reference):",
    "### Documentation (blocking)",
    "[error] usage limit reached (quoted by a prior review, not a provider error)",
    "### ⚙️ System",
    `[error] ${FREE_CAP}`,
  ].join("\n")
  assert.deepEqual(errorLinesFromText(exported), [FREE_CAP])
})

const LADDER = `
# Zen keys fund the opencode route, Go keys fall back to Go flash
ZEN_A opencode
ZEN_B opencode
GO_A ${GO_FLASH} OPENCODE_GO_API_KEY
GO_B ${GO_FLASH} OPENCODE_GO_API_KEY
`

test("parseCredentialLadder: env name, route or model, export names", () => {
  assert.deepEqual(parseCredentialLadder(LADDER), [
    { keyEnv: "ZEN_A", route: "opencode", exportAs: [] },
    { keyEnv: "ZEN_B", route: "opencode", exportAs: [] },
    { keyEnv: "GO_A", route: "opencode-go", model: GO_FLASH, exportAs: ["OPENCODE_GO_API_KEY"] },
    { keyEnv: "GO_B", route: "opencode-go", model: GO_FLASH, exportAs: ["OPENCODE_GO_API_KEY"] },
  ])
  assert.throws(() => parseCredentialLadder("not-an-env opencode"), /not an env var name/)
  assert.throws(() => parseCredentialLadder("ZEN_A"), /names no route or model/)
})

test("resolveCredentialRungs: unset and duplicate keys, route mismatch, metered guard, exhausted pairs", () => {
  const ladder = parseCredentialLadder(LADDER)
  const env = { ZEN_A: "k1", ZEN_B: "k1", GO_A: "", GO_B: "k3" }
  const allowed = [GO_FLASH]

  const zenLane = resolveCredentialRungs({ ladder, env, laneModel: ZEN_FREE, allowedMetered: allowed })
  assert.deepEqual(
    zenLane.rungs.map(r => [r.keyEnv, r.model]),
    [
      ["ZEN_A", ZEN_FREE],
      ["GO_B", GO_FLASH],
    ],
  )
  assert.deepEqual(zenLane.skipped, ["ZEN_B holds the same key as ZEN_A", "GO_A is not set"])

  // A Go lane model (the AGENT_REVIEW_MODEL override): a Zen key cannot fund
  // it, so the Zen rungs are skipped instead of running it on a Zen key.
  const goLane = resolveCredentialRungs({ ladder, env, laneModel: "opencode-go/glm-5.3", allowedMetered: allowed })
  assert.deepEqual(goLane.rungs.map(r => [r.keyEnv, r.model]), [["GO_B", "opencode-go/glm-5.3"]])

  // A metered fallback model that the owner did not allowlist is never used.
  const unlisted = resolveCredentialRungs({ ladder, env, laneModel: ZEN_FREE, allowedMetered: [] })
  assert.deepEqual(unlisted.rungs.map(r => r.keyEnv), ["ZEN_A"])
  assert.match(unlisted.skipped.join("\n"), /GO_B: opencode-go\/deepseek-v4.1-flash is metered and not listed/)

  // An earlier lane of the job already found ZEN_A capped on this model.
  const later = resolveCredentialRungs({
    ladder,
    env,
    laneModel: ZEN_FREE,
    allowedMetered: allowed,
    exhausted: [`ZEN_A ${ZEN_FREE}`],
  })
  assert.deepEqual(later.rungs.map(r => r.keyEnv), ["GO_B"])
})

test("reviewConfigForRung: the rung model reaches reviewerModel, per-verb models and rotate targets", () => {
  const config = {
    model: ZEN_FREE,
    reviewerModel: ZEN_FREE,
    commands: { fix: { reviewerModel: ZEN_FREE, skills: ["x"] }, review: { skills: ["y"] } },
    reviewerTurnRetry: {
      on: ["usage-limit"],
      rotate: [{ model: "opencode/mimo-v2.6-flash-free" }],
      fallback: [{ model: GO_FLASH }],
    },
  }
  const go = reviewConfigForRung(config, GO_FLASH)
  assert.equal(go.reviewerModel, GO_FLASH)
  assert.equal(go.model, GO_FLASH)
  assert.equal(go.commands.fix.reviewerModel, GO_FLASH)
  assert.deepEqual(go.commands.review, { skills: ["y"] })
  assert.equal(go.reviewerTurnRetry.rotate, undefined)
  assert.deepEqual(go.reviewerTurnRetry.fallback, [{ model: GO_FLASH }])
  // Same route: per-verb overrides and rotate targets are kept.
  const zen = reviewConfigForRung(config, "opencode/mimo-v2.6-flash-free")
  assert.equal(zen.commands.fix.reviewerModel, ZEN_FREE)
  assert.deepEqual(zen.reviewerTurnRetry.rotate, [{ model: "opencode/mimo-v2.6-flash-free" }])
})

// ── run-with-rotation.mjs against a fake driver ─────────────────────────────

const FAKE_DRIVER = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
const key = process.env.PROVIDER_KEY
const config = JSON.parse(readFileSync(join(homedir(), ".agentproto", "config.json"), "utf8"))
appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  key,
  goKey: process.env.OPENCODE_GO_API_KEY ?? null,
  configKey: config.defaults.adapters.opencode.auth.apiKey,
  configModel: config.defaults.adapters.opencode.options?.model ?? null,
  model: JSON.parse(process.env.WORKFLOW_INPUT).reviewConfig.reviewerModel,
  fixModel: JSON.parse(process.env.WORKFLOW_INPUT).reviewConfig.commands?.fix?.reviewerModel ?? null,
  port: process.env.PORT,
  ladderNamesVisible: ["ZEN_A", "ZEN_B", "GO_A"].filter(n => n in process.env),
}) + "\\n")
const plan = JSON.parse(process.env.FAKE_PLAN)[key] ?? { exit: 1, errorTexts: ["unplanned key"] }
if (process.env.DRIVER_RESULT_FILE) writeFileSync(process.env.DRIVER_RESULT_FILE, JSON.stringify({ exitCode: plan.exit, status: plan.exit ? "failed" : "done", artifacts: plan.artifacts ?? 0, stepsDone: plan.stepsDone ?? 0, errorTexts: plan.errorTexts ?? [] }))
process.exit(plan.exit)
`

function runRotation({ ladder, plan, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "credential-rotation-"))
  const home = join(dir, "home")
  mkdirSync(join(home, ".agentproto"), { recursive: true })
  writeFileSync(
    join(home, ".agentproto", "config.json"),
    JSON.stringify({ defaults: { adapters: { opencode: { auth: { mode: "api-key", apiKey: "action-input-key" } } } } }),
  )
  const driver = join(dir, "fake-driver.mjs")
  writeFileSync(driver, FAKE_DRIVER)
  const log = join(dir, "attempts.jsonl")
  writeFileSync(log, "")
  const res = spawnSync(process.execPath, [join(HERE, "run-with-rotation.mjs")], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      RUNNER_TEMP: dir,
      RUN_CWD: dir,
      AGENTPROTO_RUN_DRIVER: driver,
      FAKE_LOG: log,
      FAKE_PLAN: JSON.stringify(plan),
      ADAPTER: "opencode",
      PROVIDER_KEY_ENV: "OPENCODE_API_KEY",
      PROVIDER_KEY: "action-input-key",
      PORT: "18790",
      TIMEOUT_MINUTES: "50",
      LANE_MODEL: ZEN_FREE,
      AGENT_ALLOWED_METERED_MODELS: GO_FLASH,
      CREDENTIAL_LADDER: ladder,
      WORKFLOW_INPUT: JSON.stringify({
        prNumber: 1,
        reviewConfig: { reviewerModel: ZEN_FREE, commands: { fix: { reviewerModel: ZEN_FREE } } },
      }),
      ZEN_A: "zen-a",
      ZEN_B: "zen-b",
      GO_A: "go-a",
      ...env,
    },
  })
  const attempts = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line))
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, attempts }
}

const ROTATION_LADDER = `ZEN_A opencode\nZEN_B opencode\nGO_A ${GO_FLASH} OPENCODE_GO_API_KEY\n`
const capped = { exit: 1, errorTexts: ["session sess_1 produced an empty turn", FREE_CAP] }

test("run-with-rotation: a capped key moves to the next key, then to Go flash on a Go key", () => {
  const { status, stdout, attempts } = runRotation({
    ladder: ROTATION_LADDER,
    plan: { "zen-a": capped, "zen-b": capped, "go-a": { exit: 0 } },
  })
  assert.equal(status, 0, stdout)
  assert.deepEqual(
    attempts.map(a => [a.key, a.model]),
    [
      ["zen-a", ZEN_FREE],
      ["zen-b", ZEN_FREE],
      ["go-a", GO_FLASH],
    ],
  )
  const go = attempts[2]
  assert.equal(go.configKey, "go-a", "the host adapter auth follows the rung")
  assert.equal(go.configModel, GO_FLASH)
  assert.equal(go.fixModel, GO_FLASH, "the fixer moves to the Go route with the key")
  assert.equal(go.goKey, "go-a", "the Go provider variable carries the rung's Go key")
  assert.equal(attempts[0].goKey, null)
  assert.deepEqual(new Set(attempts.map(a => a.port)).size, 3, "each attempt boots its own daemon port")
  for (const a of attempts) assert.deepEqual(a.ladderNamesVisible, [], "only the active key reaches the driver")
  assert.match(stdout, /ZEN_A answered usage-limit on opencode\/deepseek-v4.1-flash-free; moving to ZEN_B/)
  assert.match(stdout, /ZEN_B answered usage-limit .*; moving to GO_A with opencode-go\/deepseek-v4.1-flash/)
  for (const secret of ["zen-a", "zen-b", "go-a"]) assert.doesNotMatch(stdout, new RegExp(`\\b${secret}\\b`))
})

test("run-with-rotation: a Go lane model (AGENT_REVIEW_MODEL) reaches the workflow and skips the Zen keys", () => {
  // 2026-11-13: the override printed "Reviewer model overridden" but the
  // session ran the config's free Zen model on the Go key (an empty turn).
  const { status, attempts } = runRotation({
    ladder: ROTATION_LADDER,
    plan: { "go-a": { exit: 0 } },
    env: { LANE_MODEL: GO_FLASH },
  })
  assert.equal(status, 0)
  assert.deepEqual(attempts.map(a => [a.key, a.model, a.fixModel]), [["go-a", GO_FLASH, GO_FLASH]])
})

// agentproto/ts#2710 run 43462039563: the second Zen key ended in an empty turn
// with no `[error]` line, and the lane stopped there instead of reaching Go.
const EMPTY_TURN =
  "session sess_0b3aa664 produced an empty turn, no assistant output or tool call (commonly an auth failure or an invalid model id)"

test("run-with-rotation: an empty turn moves to the next rung, logged as its own reason", () => {
  const { status, attempts, stdout } = runRotation({
    ladder: ROTATION_LADDER,
    plan: { "zen-a": capped, "zen-b": { exit: 1, errorTexts: [EMPTY_TURN] }, "go-a": { exit: 0 } },
  })
  assert.equal(status, 0, stdout)
  assert.deepEqual(attempts.map(a => [a.key, a.model]), [
    ["zen-a", ZEN_FREE],
    ["zen-b", ZEN_FREE],
    ["go-a", GO_FLASH],
  ])
  assert.match(stdout, /ZEN_B answered empty-turn on opencode\/deepseek-v4.1-flash-free; moving to GO_A/)
})

test("run-with-rotation: an expired key moves to the next rung", () => {
  // Same run, mimo lane: `[error] This API key has expired. Create a new API key ...`
  const { status, attempts, stdout } = runRotation({
    ladder: ROTATION_LADDER,
    plan: {
      "zen-a": {
        exit: 1,
        errorTexts: [EMPTY_TURN, "This API key has expired. Create a new API key in OpenCode Console"],
      },
      "zen-b": { exit: 0 },
    },
  })
  assert.equal(status, 0, stdout)
  assert.deepEqual(attempts.map(a => a.key), ["zen-a", "zen-b"])
  assert.match(stdout, /ZEN_A answered key-expired/)
})

test("run-with-rotation: a refused key is the one failure that does not rotate", () => {
  for (const refused of ["Invalid credential", "401 Unauthorized", "status: 401"]) {
    const { status, attempts, stdout } = runRotation({
      ladder: ROTATION_LADDER,
      plan: { "zen-a": { exit: 1, errorTexts: [EMPTY_TURN, refused] }, "zen-b": { exit: 0 } },
    })
    assert.equal(status, 1, refused)
    assert.deepEqual(attempts.map(a => a.key), ["zen-a"], refused)
    assert.match(stdout, /ZEN_A: the key was refused, not rotating/, refused)
  }
})

test("run-with-rotation: an empty turn after a completed step does not rotate", () => {
  const { status, attempts } = runRotation({
    ladder: ROTATION_LADDER,
    plan: { "zen-a": { exit: 1, errorTexts: [EMPTY_TURN], stepsDone: 1 }, "zen-b": { exit: 0 } },
  })
  assert.equal(status, 1)
  assert.deepEqual(attempts.map(a => a.key), ["zen-a"])
})

test("run-with-rotation: a failure that names no rotation reason does not rotate", () => {
  const { status, attempts, stdout } = runRotation({
    ladder: ROTATION_LADDER,
    plan: { "zen-a": { exit: 1, errorTexts: ["workflow_status failed: run not found"] }, "zen-b": { exit: 0 } },
  })
  assert.equal(status, 1)
  assert.deepEqual(attempts.map(a => a.key), ["zen-a"])
  assert.match(stdout, /ZEN_A: the failure names no quota, credit, expiry or empty turn, not rotating/)
})

test("run-with-rotation: a run that already completed a step or delivered is never re-run", () => {
  for (const progress of [{ stepsDone: 1 }, { artifacts: 1 }]) {
    const { status, attempts } = runRotation({
      ladder: ROTATION_LADDER,
      plan: { "zen-a": { ...capped, ...progress }, "zen-b": { exit: 0 } },
    })
    assert.equal(status, 1)
    assert.deepEqual(attempts.map(a => a.key), ["zen-a"], JSON.stringify(progress))
  }
})

test("run-with-rotation: every rung capped ends failed after the last rung", () => {
  const { status, attempts, stdout } = runRotation({
    ladder: ROTATION_LADDER,
    plan: { "zen-a": capped, "zen-b": capped, "go-a": { exit: 1, errorTexts: ["Go usage limit exceeded"] } },
  })
  assert.equal(status, 1)
  assert.deepEqual(attempts.map(a => a.key), ["zen-a", "zen-b", "go-a"])
  assert.match(stdout, /GO_A answered usage-limit on opencode-go\/deepseek-v4.1-flash; no rung left/)
})

test("run-with-rotation: without a ladder the driver runs once with the action's key", () => {
  const { status, attempts } = runRotation({
    ladder: "",
    plan: { "action-input-key": { exit: 0 } },
  })
  assert.equal(status, 0)
  assert.deepEqual(attempts.map(a => [a.key, a.configKey]), [["action-input-key", "action-input-key"]])
})

// ── wiring ──────────────────────────────────────────────────────────────────

const read = rel => readFileSync(join(REPO, rel), "utf8")

/** The `with:`/`env:` text of the workflow step whose `id:` is `id`. */
const stepBlock = (yaml, id) => {
  const start = yaml.indexOf(`id: ${id}\n`)
  assert.notEqual(start, -1, `step ${id} not found`)
  const next = yaml.indexOf("\n      - name:", start)
  return yaml.slice(start, next === -1 ? undefined : next)
}

/** The ladder lines of a step: `credential-ladder: |` and its indented body. */
const ladderOf = block => {
  const m = /credential-ladder: \|\n((?:\s{12}.*\n)+)/.exec(block)
  assert.ok(m, "step has no credential-ladder")
  return parseCredentialLadder(m[1])
}

test("action.yml runs the driver through run-with-rotation.mjs with the ladder", () => {
  const action = read(".github/actions/agentproto-run/action.yml")
  assert.match(action, /run: node "\$\{\{ github\.action_path \}\}\/run-with-rotation\.mjs"/)
  assert.match(action, /CREDENTIAL_LADDER: \$\{\{ inputs\.credential-ladder \}\}/)
  assert.match(action, /LANE_MODEL: \$\{\{ inputs\.model \}\}/)
})

test("ci.yml and the manual review rotate Zen keys, then Go flash on a Go key", () => {
  const lanes = [
    [read(".github/workflows/ci.yml"), "reviewer-agentproto"],
    [read(".github/workflows/ci.yml"), "reviewer-agentproto-opencode"],
    [read(".github/workflows/agentic-review-manual.yml"), "manual-review"],
  ]
  for (const [yaml, id] of lanes) {
    const block = stepBlock(yaml, id)
    const ladder = ladderOf(block)
    const zen = ladder.filter(e => e.route === "opencode")
    const go = ladder.filter(e => e.route === "opencode-go")
    assert.ok(zen.length >= 2, `${id}: at least two Zen keys`)
    assert.ok(go.length >= 1, `${id}: a Go key`)
    assert.ok(ladder.indexOf(zen.at(-1)) < ladder.indexOf(go[0]), `${id}: Zen keys before the Go keys`)
    // ws01 hodl, then ws01 agentik, then the legacy key whose org is unknown.
    assert.deepEqual(
      go.map(g => g.keyEnv),
      ["OPENCODE_GO_API_KEY_HODL", "OPENCODE_GO_API_KEY_WS01", "OPENCODE_GO_API_KEY_DEFAULT"],
      `${id}: Go key order`,
    )
    for (const g of go) {
      assert.equal(g.model, GO_FLASH, `${id}: Go rungs fall back to Go flash`)
      assert.deepEqual(g.exportAs, ["OPENCODE_GO_API_KEY"], `${id}: the Go provider variable follows the rung`)
    }
    for (const e of ladder) {
      assert.match(block, new RegExp(`\\n\\s+${e.keyEnv}: \\$\\{\\{ secrets\\.`), `${id}: ${e.keyEnv} comes from a secret`)
    }
  }
})

test("the auto-fix lane rotates Zen keys only (the fixer never uses a Go key)", () => {
  const ladder = ladderOf(stepBlock(read(".github/workflows/ci.yml"), "fixer-lane"))
  assert.ok(ladder.length >= 2)
  assert.deepEqual([...new Set(ladder.map(e => e.route))], ["opencode"])
})
