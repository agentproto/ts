#!/usr/bin/env node
// Entry of the agentproto-run action's "Boot daemon and drive workflow" step.
//
// Without a `credential-ladder` input this runs driver.mjs once, exactly as the
// step did before. With one, it runs the driver once per usable rung (see
// credential-rotation.mjs for the grammar) and stops at the first run that
// succeeds. It moves to the next rung only when the failed run:
//
//   · names a quota or credit exhaustion, an expired key, or an empty turn in
//     its error texts (the driver writes them to DRIVER_RESULT_FILE: run/step
//     errors, each session's last turn error, and the adapter's `[error]`
//     lines), and not a refused key (`Invalid credential`, 401), and
//   · completed no workflow step and delivered nothing (no review, PR or
//     comment in its artifact ledger), so a second run can never post a
//     duplicate.
//
// Each attempt boots its own daemon (the key lives in the daemon env and in
// `~/.agentproto/config.json`), on its own port, with the time left of the
// action's `timeout-minutes`. Only env names and models are logged, never a
// key.

import { spawn } from "node:child_process"
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  agentConfigForRung,
  exhaustedRecord,
  parseCredentialLadder,
  resolveCredentialRungs,
  rotationDecision,
  workflowInputForRung,
} from "./credential-rotation.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const DRIVER = process.env.AGENTPROTO_RUN_DRIVER || join(HERE, "driver.mjs")
const log = line => console.log(`credential rotation: ${line}`)

let child
const forward = signal => () => {
  if (child && child.exitCode === null) child.kill(signal)
  else process.exit(signal === "SIGINT" ? 130 : 143)
}
process.on("SIGINT", forward("SIGINT"))
process.on("SIGTERM", forward("SIGTERM"))

function runDriver(env) {
  return new Promise(resolvePromise => {
    child = spawn(process.execPath, [DRIVER], { env, stdio: "inherit" })
    child.on("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)))
    child.on("error", err => {
      console.error(`credential rotation: could not start the driver: ${err.message}`)
      resolvePromise(1)
    })
  })
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

function writeOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT
  if (file) appendFileSync(file, `${name}=${value}\n`, "utf8")
}

async function main() {
  const spec = process.env.CREDENTIAL_LADDER ?? ""
  if (!spec.trim()) return runDriver(process.env)

  const ladder = parseCredentialLadder(spec)
  const scratch = process.env.RUNNER_TEMP || tmpdir()
  const exhaustedFile = join(scratch, "agentproto-run-exhausted-credentials.json")
  const prior = readJson(exhaustedFile)
  const exhausted = Array.isArray(prior) ? prior.filter(e => typeof e === "string") : []
  const allowedMetered = (process.env.AGENT_ALLOWED_METERED_MODELS ?? "").split(/[\s,]+/).filter(Boolean)
  const workflowInput = process.env.WORKFLOW_INPUT ?? "{}"
  let laneModel = (process.env.LANE_MODEL ?? "").trim()
  if (!laneModel) {
    try {
      const m = JSON.parse(workflowInput)?.reviewConfig?.reviewerModel
      if (typeof m === "string") laneModel = m.trim()
    } catch {
      // no lane model: only rungs that name their own model can run
    }
  }

  const { rungs, skipped } = resolveCredentialRungs({ ladder, env: process.env, laneModel, allowedMetered, exhausted })
  for (const line of skipped) log(`skipping ${line}`)
  if (rungs.length === 0) {
    log("no usable rung, running once with the action's own api-key input")
    return runDriver(process.env)
  }
  log(`ladder: ${rungs.map(r => `${r.keyEnv} (${r.model})`).join(" -> ")}`)

  const adapter = process.env.ADAPTER ?? ""
  const cwd = resolve(process.env.RUN_CWD || process.cwd())
  const configPath = join(homedir(), ".agentproto", "config.json")
  const basePort = Number(process.env.PORT ?? "18790")
  const budgetMs = Number(process.env.TIMEOUT_MINUTES ?? "360") * 60_000
  const deadline = Date.now() + budgetMs
  const ladderEnvNames = new Set(ladder.map(e => e.keyEnv))

  let code = 1
  for (let i = 0; i < rungs.length; i++) {
    const rung = rungs[i]
    const key = process.env[rung.keyEnv]
    const env = { ...process.env }
    for (const name of ladderEnvNames) delete env[name]
    env.PROVIDER_KEY = key
    for (const name of rung.exportAs) env[name] = key
    env.WORKFLOW_INPUT = workflowInputForRung(workflowInput, rung.model)
    env.PORT = String(basePort + i)
    const remainingMin = Math.max(1, Math.floor((deadline - Date.now()) / 60_000))
    env.TIMEOUT_MINUTES = String(remainingMin)
    const resultFile = join(scratch, `agentproto-run-result-${process.pid}-${i}.json`)
    env.DRIVER_RESULT_FILE = resultFile

    const config = readJson(configPath)
    if (config) writeFileSync(configPath, JSON.stringify(agentConfigForRung(config, adapter, rung, key), null, 2))
    // A previous attempt's daemon left its runtime.json (port + bearer); the
    // next driver must not read it before its own daemon rewrites it.
    if (i > 0) rmSync(join(cwd, ".agentproto", "runtime.json"), { force: true })

    log(`attempt ${i + 1}/${rungs.length}: ${rung.keyEnv} with ${rung.model}`)
    writeOutput("credential", rung.keyEnv)
    code = await runDriver(env)
    if (code === 0) return 0

    const result = readJson(resultFile)
    if (!result) {
      log(`${rung.keyEnv}: the driver left no result, not rotating`)
      return code
    }
    if (result.artifacts > 0 || result.stepsDone > 0) {
      log(
        `${rung.keyEnv}: the failed run already completed ${result.stepsDone ?? 0} step(s) and delivered ` +
          `${result.artifacts ?? 0} artifact(s); a second run could repeat them, not rotating`,
      )
      return code
    }
    const decision = rotationDecision(result)
    if (!decision.rotate) {
      log(
        decision.reason === "key-refused"
          ? `${rung.keyEnv}: the key was refused, not rotating (fix or remove this secret)`
          : `${rung.keyEnv}: the failure names no quota, credit, expiry or empty turn, not rotating`,
      )
      return code
    }
    const failureClass = decision.reason
    exhausted.push(exhaustedRecord(rung, failureClass))
    try {
      writeFileSync(exhaustedFile, JSON.stringify(exhausted))
    } catch {
      // best effort: a later lane of the job may retry this key
    }
    const next = rungs[i + 1]
    if (!next) {
      log(`${rung.keyEnv} answered ${failureClass} on ${rung.model}; no rung left`)
      return code
    }
    if (deadline - Date.now() < 120_000) {
      log(`${rung.keyEnv} answered ${failureClass}; less than 2 minutes left, not rotating`)
      return code
    }
    log(`${rung.keyEnv} answered ${failureClass} on ${rung.model}; moving to ${next.keyEnv} with ${next.model}`)
  }
  return code
}

let exitCode = 1
try {
  exitCode = await main()
} catch (err) {
  console.error(`credential rotation: ${err instanceof Error ? err.message : String(err)}`)
  exitCode = 1
}
process.exit(exitCode)
