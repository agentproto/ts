#!/usr/bin/env node
/**
 * Smoke proof for an adapter pin change: spawn the adapter through the repo's
 * own CLI (`agentproto run <slug>`), dispatch ONE turn, and assert the reply.
 *
 * Subcommands:
 *   plan --base <git-ref>     print the matrix of adapters whose pin differs
 *                             from <git-ref> (JSON: {"include":[{"adapter":..}]})
 *   run  --adapter <slug>     real spawn + one turn; writes a result and exits
 *        [--cli <cli.mjs>] [--timeout-ms <n>] [--result-out <file>]
 *
 * Outcomes of `run`:
 *   proven   exit 0, the reply contains PONG
 *   failed   exit 1 (spawn error, timeout, wrong or empty reply)
 *   skipped  exit 0 but LOUD (::warning:: + job summary): no credential for
 *            this adapter in this environment, or no smoke recipe. Skipped is
 *            never reported as proven.
 *
 * Never pins a model id: the opencode free route discovers a zero-priced
 * model at run time from the installed opencode's own model list.
 */

import { execFile, spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { collectPins, parseAdapterSource } from "./check-adapter-pins.mjs"

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")

/** The prompt must NOT contain the expected token, so an echoed prompt cannot pass. */
export const PROMPT =
  "Spell the word GNOP backwards, in capital letters. Reply with only that word and nothing else. Do not use any tools."
export const EXPECTED = "PONG"

/**
 * Per-adapter recipe. `env` lists alternative credential variables (any one
 * suffices); `freeRoute` means no credential, a free model is discovered.
 */
export const RECIPES = {
  opencode: { freeRoute: true },
  "claude-code": { env: ["ANTHROPIC_API_KEY"] },
  codex: { env: ["OPENAI_API_KEY"] },
  gemini: { env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  mastracode: { env: ["ANTHROPIC_API_KEY"] },
  "mastracode-inprocess": { env: ["ANTHROPIC_API_KEY"] },
}

/** Decide whether a recipe can run with the given env. Pure. */
export function resolveRecipe(adapter, env) {
  const recipe = RECIPES[adapter]
  if (!recipe) return { action: "skip", reason: "no smoke recipe for this adapter" }
  if (recipe.freeRoute) return { action: "run", freeRoute: true }
  const present = recipe.env.find((name) => env[name])
  if (!present) {
    return { action: "skip", reason: `no credential: needs repo secret ${recipe.env.join(" or ")}` }
  }
  return { action: "run", freeRoute: false }
}

/** Pick a zero-priced active model from `opencode models <provider> --verbose`. Pure. */
export function pickFreeModel(verboseOutput) {
  const lines = verboseOutput.split("\n")
  const free = []
  for (let i = 0; i < lines.length; i++) {
    const header = /^([\w.-]+\/[\w.:/-]+)$/.exec(lines[i].trim())
    if (!header || lines[i + 1]?.trim() !== "{") continue
    let end = i + 1
    while (end < lines.length && lines[end] !== "}") end++
    let info
    try {
      info = JSON.parse(lines.slice(i + 1, end + 1).join("\n"))
    } catch {
      continue
    }
    const cost = info.cost
    const zero =
      cost && cost.input === 0 && cost.output === 0 && (cost.cache?.read ?? 0) === 0 && (cost.cache?.write ?? 0) === 0
    const textOut = info.capabilities?.output?.text !== false
    if (zero && info.status !== "deprecated" && textOut) free.push(header[1])
    i = end
  }
  free.sort()
  return free[0] ?? null
}

export function evaluateReply(output) {
  if (!output.trim()) return { ok: false, reason: "empty reply" }
  if (!output.includes(EXPECTED)) return { ok: false, reason: `reply does not contain ${EXPECTED}` }
  return { ok: true, reason: `reply contains ${EXPECTED}` }
}

/** Adapters whose npm pins differ between two pin sets. Pure. */
export function diffPins(basePins, headPins) {
  const key = (pin) => `${pin.adapter}\u0000${pin.package}`
  const base = new Map(basePins.map((pin) => [key(pin), pin.pinned]))
  const changed = new Map()
  for (const pin of headPins) {
    const before = base.get(key(pin))
    if (before !== undefined && before !== pin.pinned) {
      const list = changed.get(pin.adapter) ?? []
      list.push({ package: pin.package, from: before, to: pin.pinned })
      changed.set(pin.adapter, list)
    }
  }
  return [...changed.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([adapter, changes]) => ({ adapter, changes }))
}

async function planFromGit(baseRef) {
  const head = collectPins().pins
  const base = []
  for (const adapter of new Set(head.map((pin) => pin.adapter))) {
    let source
    try {
      const { stdout } = await execFileAsync("git", ["show", `${baseRef}:adapters/${adapter}/src/index.ts`], {
        cwd: ROOT,
        maxBuffer: 16 * 1024 * 1024,
      })
      source = stdout
    } catch {
      continue
    }
    for (const pin of parseAdapterSource(source)) base.push({ adapter, ...pin })
  }
  return diffPins(base, head)
}

function runCli(cli, args, { cwd, timeoutMs, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (out += chunk))
    child.on("close", (code) => {
      clearTimeout(timer)
      resolvePromise({ code, out, timedOut })
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      resolvePromise({ code: 1, out: `${out}\n${error.message}`, timedOut })
    })
  })
}

async function discoverFreeModel() {
  const { stdout } = await execFileAsync("npx", ["-y", "opencode-ai", "models", "opencode", "--verbose"], {
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  return pickFreeModel(stdout)
}

async function runSmoke({ adapter, cli, timeoutMs, env }) {
  const decision = resolveRecipe(adapter, env)
  if (decision.action === "skip") return { adapter, status: "skipped", detail: decision.reason }
  const args = ["run", adapter, "--prompt", PROMPT]
  let model = null
  if (decision.freeRoute) {
    try {
      model = await discoverFreeModel()
    } catch (error) {
      return { adapter, status: "failed", detail: `free model discovery failed: ${error.message}` }
    }
    if (!model) return { adapter, status: "failed", detail: "no zero-priced model found for the free route" }
    args.push("--model", model)
  }
  const cwd = mkdtempSync(join(tmpdir(), `pin-smoke-${adapter}-`))
  const { code, out, timedOut } = await runCli(cli, args, { cwd, timeoutMs, env })
  const tail = out.trim().split("\n").slice(-12).join("\n")
  if (timedOut) return { adapter, status: "failed", model, detail: `timed out after ${timeoutMs} ms`, tail }
  if (code !== 0) return { adapter, status: "failed", model, detail: `agentproto run exited ${code}`, tail }
  const verdict = evaluateReply(out)
  return { adapter, status: verdict.ok ? "proven" : "failed", model, detail: verdict.reason, tail }
}

function report(result) {
  const icon = { proven: "PROVEN", failed: "FAILED", skipped: "SKIPPED" }[result.status]
  const lines = [
    `### Adapter pin smoke: ${result.adapter}: ${icon}`,
    "",
    `- result: **${result.status}**${result.status === "skipped" ? " (NOT proven: this adapter was not exercised)" : ""}`,
    `- detail: ${result.detail}`,
  ]
  if (result.model) lines.push(`- model (discovered at run time): \`${result.model}\``)
  if (result.status === "failed" && result.tail) lines.push("", "```", result.tail, "```")
  lines.push("")
  const text = lines.join("\n")
  console.log(text)
  if (result.status === "skipped") {
    console.log(`::warning title=Adapter pin smoke SKIPPED (${result.adapter})::${result.detail}. The bumped pin is NOT proven.`)
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

function flag(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? null : argv[index + 1]
}

async function main() {
  const [command, ...argv] = process.argv.slice(2)
  if (command === "plan") {
    const base = flag(argv, "--base")
    if (!base) throw new Error("plan needs --base <git-ref>")
    const changed = await planFromGit(base)
    process.stdout.write(`${JSON.stringify({ include: changed.map(({ adapter }) => ({ adapter })), changed })}\n`)
    return
  }
  if (command === "run") {
    const adapter = flag(argv, "--adapter")
    if (!adapter) throw new Error("run needs --adapter <slug>")
    const cli = resolve(flag(argv, "--cli") ?? join(ROOT, "packages/cli/dist/cli.mjs"))
    if (!existsSync(cli)) throw new Error(`CLI not built: ${cli}`)
    const timeoutMs = Number(flag(argv, "--timeout-ms") ?? 240_000)
    const result = await runSmoke({ adapter, cli, timeoutMs, env: process.env })
    report(result)
    const out = flag(argv, "--result-out")
    if (out) writeFileSync(out, `${JSON.stringify(result)}\n`)
    process.exitCode = result.status === "failed" ? 1 : 0
    return
  }
  throw new Error("usage: adapter-pin-smoke.mjs plan --base <ref> | run --adapter <slug>")
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
