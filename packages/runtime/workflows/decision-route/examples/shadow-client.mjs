#!/usr/bin/env node
// Executable shadow-mode client for the decision-route workflow. A review
// gate (e.g. studio's scripts/gate.mjs) calls this beside its own router: it
// runs the shipped workflow in SHADOW mode (no review lane starts), waits for
// the report and appends one JSON line to a shadow log. It never affects the
// gate's verdict and never edits shared config.
//
//   node shadow-client.mjs --repo /path/to/repo [--from <sha> --to <sha>] \
//     [--exec-profile subscription|free-only] [--escalation-preset <id>] \
//     [--log .logs/gate/router/decision-route-shadow.jsonl] [--wait-ms 600000]
//
// Requires the `agentproto` CLI on PATH and a running daemon that has the
// `decision_*` tools. GATE_EXEC_PROFILE is honoured when --exec-profile is
// absent. A DECISION.md and REVIEW.md must exist in --repo (see this folder).

import { execFile } from "node:child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs, promisify } from "node:util"

const run = promisify(execFile)
const WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), "..", "WORKFLOW.md")

/** GATE_EXEC_PROFILE spelling -> workflow profile id. Anything else is null. */
export function profileFor(execProfile) {
  const v = String(execProfile ?? "subscription").trim().toLowerCase() || "subscription"
  if (v === "free-only") return "local-free"
  if (v === "subscription") return "remote-sonnet"
  return null
}

const DOC_EXT = /\.(md|mdx|txt|rst|png|jpe?g|gif|svg|webp|ico|lock)$/i

/** Metadata-only evidence from a router's file list (never paths or code).
 *  `rule` is the router's own result — its categories/signals are passed as
 *  names; its DECISION is deliberately NOT, so a shadow comparison is real. */
export function buildEvidence(files, rule = {}) {
  const list = Array.isArray(files) ? files : []
  const docsOnly = list.length > 0 && list.every(f => DOC_EXT.test(String(f.path ?? "")))
  return {
    changeCounts: {
      files: list.length,
      added: list.reduce((n, f) => n + (Number(f.added) || 0), 0),
      deleted: list.reduce((n, f) => n + (Number(f.deleted) || 0), 0),
    },
    changeTypes: docsOnly ? "docs-only" : "code",
    riskCategories: Array.isArray(rule.categories) ? rule.categories.map(String) : [],
    signals: Array.isArray(rule.signals) ? rule.signals.map(String) : [],
    completeness: 1,
  }
}

export function buildShadowInput({ repo, from, to, execProfile, escalationPreset, evidence, parentSessionId }) {
  const profile = profileFor(execProfile)
  if (!profile) throw new Error(`exec profile "${execProfile}" is not subscription | free-only`)
  return {
    cwd: repo,
    policyPath: "DECISION.md",
    profile,
    mode: "shadow",
    ...(from ? { base: from } : {}),
    ...(to ? { head: to } : {}),
    ...(evidence ? { evidence } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(escalationPreset ? { profileOptions: { escalation: { preset: escalationPreset } } } : {}),
  }
}

const cli = async (args) => JSON.parse((await run("agentproto", args, { maxBuffer: 8 * 1024 * 1024 })).stdout)

/** Run the workflow and wait (bounded) for the `validate` step's report. */
export async function runShadow(input, { repo, waitMs = 600_000, pollMs = 2_000, exec = cli } = {}) {
  const started = await exec(["workflow", "run-file", WORKFLOW, "--cwd", repo, "--input-json", JSON.stringify(input), "--json"])
  const runId = started.runId
  const deadline = Date.now() + waitMs
  for (;;) {
    const status = await exec(["workflow", "status", runId, "--json"])
    if (["done", "failed", "cancelled"].includes(status.status)) return { runId, status }
    if (Date.now() > deadline) {
      await exec(["workflow", "cancel", runId, "--json"]).catch(() => {})
      return { runId, status: { status: "timeout" } }
    }
    await new Promise(r => setTimeout(r, pollMs))
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      "exec-profile": { type: "string" },
      "escalation-preset": { type: "string" },
      log: { type: "string" },
      "wait-ms": { type: "string" },
    },
  })
  const repo = resolve(values.repo ?? process.cwd())
  const input = buildShadowInput({
    repo,
    from: values.from,
    to: values.to,
    execProfile: values["exec-profile"] ?? process.env.GATE_EXEC_PROFILE,
    escalationPreset: values["escalation-preset"],
  })
  const { runId, status } = await runShadow(input, { repo, waitMs: Number(values["wait-ms"] ?? 600_000) })
  const record = { at: new Date().toISOString(), runId, input: { ...input, evidence: undefined }, status }
  const log = resolve(repo, values.log ?? ".logs/gate/router/decision-route-shadow.jsonl")
  mkdirSync(dirname(log), { recursive: true })
  appendFileSync(log, JSON.stringify(record) + "\n")
  process.stdout.write(`[decision-route] shadow run ${runId}: ${status.status} (logged to ${log})\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    process.stderr.write(`[decision-route] shadow failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(0)
  })
}
