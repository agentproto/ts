#!/usr/bin/env node
/**
 * scripts/verify.mjs — the app's verify umbrella (APP.md `verify.command`).
 *
 * Runs every gate (today: `gates/example.mjs`) from the app root — no
 * shell, plain argv — and prints ONE line of JSON: {ok, findings[]}, where
 * findings folds the gates' own findings plus one per failing gate. Exit 0
 * iff every gate passed, so `agentproto app validate` can propagate it.
 */

import { spawnSync } from "node:child_process"

const GATES = [["node", ["gates/example.mjs"]]]

const findings = []
let ok = true

for (const [command, args] of GATES) {
  const res = spawnSync(command, args, { encoding: "utf8" })
  const name = `${command} ${args.join(" ")}`
  let report = null
  try {
    report = JSON.parse(String(res.stdout).trim().split("\n").pop())
  } catch {
    // not JSON — fall through to the exit-code check below
  }
  if (report && typeof report === "object" && Array.isArray(report.findings)) {
    findings.push(...report.findings)
  }
  if (res.status !== 0) {
    ok = false
    findings.push({
      scope: name,
      level: "error",
      message: `gate failed with exit code ${res.status}`,
    })
  }
}

console.log(JSON.stringify({ ok, findings }))
process.exit(ok ? 0 : 1)
