#!/usr/bin/env node
/**
 * host-guard — thin cron wrapper around `agentproto host guard`.
 *
 * There is exactly ONE implementation of the guard policy:
 * `packages/cli/src/commands/host-guard.ts`. This script only locates the CLI
 * and forwards its argv, so a cron line can keep pointing here while the
 * behaviour (reap instead of kill, CRIT floor, work-in-flight/child-alive
 * refusals) stays in one tested place.
 *
 * Cron (every 20 min):
 *   0,20,40 * * * * node /path/to/agentproto/scripts/host-guard.mjs --agent claude-code >> ~/.agentproto/host-guard.cron.log 2>&1
 *
 * Env:
 *   HOST_GUARD_BIN   agentproto binary (default: this checkout's built CLI if
 *                    present, else `agentproto` on PATH)
 *   HOST_GUARD_AGENT / HOST_GUARD_NOTIFY_SESSION are forwarded by the CLI
 *                    itself (same env names).
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, "..")
const LOCAL_CLI = join(REPO_ROOT, "packages", "cli", "dist", "cli.mjs")

function bin() {
  if (process.env.HOST_GUARD_BIN) return { cmd: process.env.HOST_GUARD_BIN, prefix: [] }
  // Prefer this checkout's build, so the script works without a global install.
  if (existsSync(LOCAL_CLI)) return { cmd: process.execPath, prefix: [LOCAL_CLI] }
  return { cmd: "agentproto", prefix: [] }
}

const { cmd, prefix } = bin()
const res = spawnSync(cmd, [...prefix, "host", "guard", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
})
if (res.error) {
  process.stderr.write(`host-guard: ${res.error.message}\n`)
  process.exitCode = 1
} else {
  process.exitCode = res.status ?? 1
}
