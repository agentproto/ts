/**
 * `installAdapter(slug)` — install an agent CLI adapter (harness) by slug,
 * the mutation companion to `listAdaptersWithAcp`.
 *
 * Three install classes, decided purely by `planAdapterInstall` (below):
 *
 *   - **acp-catalog / acp-config (npm)** — a generic ACP CLI whose
 *     `install_hint` is an `npm install -g` line (gemini-cli, qwen-code,
 *     iflow-cli). We parse the package name and run `npm i -g <package>`.
 *
 *   - **acp-catalog / acp-config (shell-hint)** — a generic ACP CLI whose
 *     `install_hint` uses a recognized non-npm package manager (uv, pip,
 *     brew, cargo, go, pipx — e.g. `uv tool install mistral-vibe`). We run
 *     the hint command directly.
 *
 *   - **first-party** — a native `@agentproto/adapter-*` adapter in the
 *     catalog (claude-code, opencode, …). Driven through the existing
 *     `agentproto install <slug>` pipeline (`runInstall`), which bootstraps
 *     the adapter package then runs its manifest `install[]` steps.
 *
 * Wired into the daemon as `createGateway({ installAgentAdapter })` — the
 * runtime stays cli-free and only exposes the `adapter_install` MCP tool +
 * `POST /adapters/:slug/install` route. Never throws for an ordinary install
 * failure: reports it via `{ ok:false, message }` so the tool/route return a
 * clean result rather than a 500.
 */

import { spawn, execFileSync } from "node:child_process"
import type { AdapterInstallResult } from "@agentproto/runtime"
import { listAdaptersWithAcp, type AdapterListing } from "./resolve.js"
import { CATALOG } from "./catalog.js"
import { runInstall } from "../commands/install.js"

/** The minimal slice of an adapter listing `planAdapterInstall` reads —
 *  a structural subset of {@link AdapterListing} so the planner stays pure
 *  and trivially unit-testable. */
export interface AdapterInstallCandidate {
  slug: string
  status?: "supported" | "available" | "ready" | "unresolvable"
  /** Present ONLY on generic ACP entries (`acp-catalog` / `acp-config`);
   *  absent on native `@agentproto/adapter-*` catalog entries. */
  source?: "acp-config" | "acp-catalog"
  /** Human "how to install" line — for acp entries this carries the npm
   *  package (`npm install -g @google/gemini-cli`). */
  hint?: string
}

/** A resolved install strategy. `command`/`args` name exactly what will run
 *  (for logs + error surfaces); `already-installed`/`unsupported` run
 *  nothing. */
export type AdapterInstallPlan =
  | { kind: "already-installed" }
  | {
      kind: "npm-global"
      packageName: string
      command: "npm"
      args: string[]
    }
  | {
      kind: "shell-hint"
      command: string
      args: string[]
    }
  | {
      kind: "agentproto-install"
      slug: string
      command: "agentproto"
      args: string[]
    }
  | { kind: "unsupported"; reason: string }

/**
 * Pull the npm package out of an acp entry's `install_hint`
 * (`"npm install -g @google/gemini-cli"` → `"@google/gemini-cli"`). Accepts
 * both `install`/`i` and `-g`/`--global` spellings. Returns `undefined` when
 * the hint isn't an npm-global install line (a BYO-binary agent, a `brew`
 * hint, etc.) — the caller then reports it as unsupported rather than
 * guessing a package.
 */
export function parseNpmPackageFromHint(hint?: string): string | undefined {
  if (!hint) return undefined
  const m = hint.match(/npm\s+(?:i|install)\s+(?:-g|--global)\s+(\S+)/)
  return m?.[1]
}

const KNOWN_INSTALL_COMMANDS: Record<string, string> = {
  npm: "https://nodejs.org/",
  uv: "curl -LsSf https://astral.sh/uv/install.sh | sh",
  pip: "comes with Python — https://www.python.org/downloads/",
  pip3: "comes with Python 3 — https://www.python.org/downloads/",
  pipx: "pip install pipx — https://pipx.pypa.io",
  brew: "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"",
  cargo: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
  go: "https://go.dev/dl/",
}

/**
 * Parse a non-npm install hint into command + args when the command is a
 * recognized package manager. Returns `undefined` for unknown commands so the
 * caller can fall through to `unsupported` rather than blindly executing
 * arbitrary shell lines.
 */
export function parseShellHint(
  hint?: string,
): { command: string; args: string[] } | undefined {
  if (!hint) return undefined
  const parts = hint.trim().split(/\s+/)
  const cmd = parts[0]
  if (!cmd || cmd === "npm" || !(cmd in KNOWN_INSTALL_COMMANDS)) return undefined
  return { command: cmd, args: parts.slice(1) }
}

/**
 * Decide how to install `entry` — pure, so it's the unit-tested heart of the
 * install flow. See the module header for the two classes.
 */
export function planAdapterInstall(
  entry: AdapterInstallCandidate,
): AdapterInstallPlan {
  if (entry.status === "ready") return { kind: "already-installed" }

  // Generic ACP agent (catalog or user config) — no adapter package, so the
  // only install path is npm-global from its hint.
  if (entry.source === "acp-catalog" || entry.source === "acp-config") {
    const pkg = parseNpmPackageFromHint(entry.hint)
    if (pkg) {
      return {
        kind: "npm-global",
        packageName: pkg,
        command: "npm",
        args: ["install", "-g", pkg],
      }
    }

    const shell = parseShellHint(entry.hint)
    if (shell) {
      return { kind: "shell-hint", command: shell.command, args: shell.args }
    }

    return {
      kind: "unsupported",
      reason: entry.hint
        ? `unrecognized install hint "${entry.hint}" — install ${entry.slug} manually.`
        : `'${entry.slug}' is a bring-your-own-binary ACP agent with no install hint — install it manually.`,
    }
  }

  // First-party native adapter — drive the existing manifest install
  // pipeline. Works whether it's "supported" (not installed → bootstrap the
  // package + run install[]) or "available" (installed, setup/auth pending →
  // idempotent re-run).
  //
  // `--allow-unverified`: this path only runs for an explicit
  // `adapter_install` / `POST /adapters/:slug/install` request — a
  // deliberate install action on a cataloged `@agentproto/adapter-*`
  // manifest, whose install steps ship inside a versioned npm package
  // rather than from anywhere caller-controlled. The daemon has no TTY, so
  // without the flag the runner's non-interactive gate would refuse every
  // curl/download-method adapter (e.g. antigravity), making them
  // permanently uninstallable from UIs. The gate keeps protecting the
  // ambient cases it was built for (agents shelling out `agentproto
  // install`, CI).
  return {
    kind: "agentproto-install",
    slug: entry.slug,
    command: "agentproto",
    args: ["install", entry.slug, "--allow-unverified"],
  }
}

function commandOnPath(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: "ignore",
    })
    return true
  } catch {
    return false
  }
}

/** Bound on a single install command. npm-global installs are network-bound;
 *  10 minutes is generous but keeps a stuck registry from hanging the daemon
 *  route forever. */
const INSTALL_TIMEOUT_MS = 10 * 60_000

interface RunResult {
  code: number
  timedOut: boolean
  output: string
}

/** Spawn a command, capture combined stdout+stderr, and enforce a timeout.
 *  On timeout the child is killed and we resolve `timedOut:true` so the
 *  caller can report cleanly instead of the route hanging. */
function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = INSTALL_TIMEOUT_MS,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let output = ""
    let settled = false
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    const cap = (buf: Buffer) => {
      output += buf.toString("utf8")
    }
    child.stdout?.on("data", cap)
    child.stderr?.on("data", cap)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      resolve({ code: -1, timedOut: true, output })
    }, timeoutMs)
    child.once("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: 127, timedOut: false, output: `${output}${err.message}` })
    })
    child.once("exit", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? 0, timedOut: false, output })
    })
  })
}

/** Run `runInstall` (the in-process manifest pipeline) bounded by a timeout.
 *  runInstall shells out with inherited stdio; racing it against a timer
 *  keeps the daemon route responsive if npm stalls (a leaked child is the
 *  acceptable cost of not reimplementing the whole install engine here). */
function runInstallBounded(
  args: string[],
  timeoutMs = INSTALL_TIMEOUT_MS,
): Promise<{ code: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ code: -1, timedOut: true })
    }, timeoutMs)
    runInstall(args)
      .then((code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, timedOut: false })
      })
      .catch((err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // runInstall itself only returns exit codes; a thrown error is an
        // unexpected internal fault — surface it as a non-zero code.
        resolve({ code: 1, timedOut: false })
        void err
      })
  })
}

/**
 * Install the adapter named by `slug` and report the outcome (never throws
 * for an ordinary failure). Lists adapters first to classify the slug, plans
 * the install, runs it, then re-reads the listing so the result carries the
 * adapter's fresh readiness `status`.
 */
export async function installAdapter(
  slug: string,
): Promise<AdapterInstallResult> {
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    return {
      slug,
      ok: false,
      method: "unsupported",
      message: `invalid adapter slug '${slug}' — slugs are lower-kebab.`,
    }
  }

  let listing: AdapterListing[]
  try {
    listing = await listAdaptersWithAcp(CATALOG)
  } catch (err) {
    return {
      slug,
      ok: false,
      method: "unsupported",
      message: `could not enumerate adapters: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const entry = listing.find((e) => e.slug === slug)
  if (!entry) {
    return {
      slug,
      ok: false,
      method: "unsupported",
      message: `unknown adapter '${slug}' — not in the catalog or ACP registry. Run adapter_list to see installable slugs.`,
    }
  }

  const plan = planAdapterInstall(entry)

  if (plan.kind === "already-installed") {
    return {
      slug,
      ok: true,
      method: "already-installed",
      message: `'${slug}' is already installed and ready.`,
      status: entry.status,
    }
  }

  if (plan.kind === "unsupported") {
    return { slug, ok: false, method: "unsupported", message: plan.reason }
  }

  const command = `${plan.command} ${plan.args.join(" ")}`
  let ok: boolean
  let exitCode: number
  let failureDetail = ""

  if (plan.kind === "npm-global" || plan.kind === "shell-hint") {
    if (!commandOnPath(plan.command)) {
      const howTo = KNOWN_INSTALL_COMMANDS[plan.command]
      return {
        slug,
        ok: false,
        method: plan.kind,
        command,
        message: `'${plan.command}' is not installed. ${slug} requires it.\nInstall ${plan.command} first: ${howTo}`,
      }
    }
    const res = await runCommand(plan.command, plan.args)
    ok = res.code === 0
    exitCode = res.code
    if (!ok) {
      failureDetail = res.timedOut
        ? ` (timed out after ${INSTALL_TIMEOUT_MS / 60_000}m)`
        : ` (exit ${res.code})${lastLine(res.output)}`
    }
  } else {
    // agentproto-install. `runInstall` is the handler FOR the `install`
    // verb — it wants the args after the verb (slug first). plan.args keeps
    // the verb so `command` logs the real invocation; strip it here or the
    // runner resolves an adapter literally named "install" and dies.
    const res = await runInstallBounded(plan.args.slice(1))
    ok = res.code === 0
    exitCode = res.code
    if (!ok) {
      failureDetail = res.timedOut
        ? ` (timed out after ${INSTALL_TIMEOUT_MS / 60_000}m)`
        : ` (exit ${res.code})`
    }
  }

  // Re-read status so the caller can refresh a row without a second call.
  // A failed re-list must not mask the install's own result.
  let freshStatus: AdapterInstallResult["status"]
  try {
    const after = await listAdaptersWithAcp(CATALOG)
    freshStatus = after.find((e) => e.slug === slug)?.status
  } catch {
    freshStatus = undefined
  }

  return {
    slug,
    ok,
    method: plan.kind,
    command,
    exitCode,
    message: ok
      ? `installed '${slug}' via \`${command}\`${freshStatus ? ` (now ${freshStatus})` : ""}.`
      : `install of '${slug}' failed${failureDetail}. Ran: \`${command}\`.`,
    ...(freshStatus ? { status: freshStatus } : {}),
  }
}

/** Last non-empty line of captured output, prefixed with `: ` — a compact
 *  tail for the failure message without dumping the whole log. */
function lastLine(output: string): string {
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
  return line ? `: ${line}` : ""
}
