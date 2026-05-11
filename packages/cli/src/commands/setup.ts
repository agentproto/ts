/**
 * `agentproto setup <slug>` + `runSetup()` engine.
 *
 * Implements AIP-29 § Setup — the post-install configuration pipeline.
 * Steps run in declared order. Idempotency comes from three layers:
 *
 *   1. Manifest's `version_check` — already covered by `install`. If the
 *      binary's version answers, install steps are skipped entirely
 *      before setup ever runs.
 *
 *   2. Per-step `skip_if.cmd` — runs first; matching exit code skips
 *      the step. Asks the live system, so it works on fresh machines
 *      without any local state.
 *
 *   3. Setup ledger — `~/.agentproto/setup/<slug>.json`, records each
 *      successful step with timestamp + (when applicable) which slot
 *      received the value. Re-runs short-circuit ledger-known steps
 *      unless --force is passed.
 *
 * The `runSetup()` export is what `agentproto install` calls after the
 * install array succeeds; `runSetupCommand()` is the standalone verb
 * (re-runs only setup, no install).
 *
 * Step `kind` matrix (current support):
 *
 *   - cmd       ✓ — shell command, optional skip_if + persist (stdout)
 *   - prompt    ✓ — text / boolean / select / secret; persist via env / secret_slug / cmd
 *   - oauth     ✗ — placeholder; needs a SECRETS.md driver wire-up
 *   - external  ⚠ — opens URL via xdg-open/open; callback polling not yet wired
 *
 * The unsupported kinds surface a clear "not yet implemented" message
 * so adapter authors can lean on cmd + prompt today and migrate later.
 */

import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { join, dirname } from "node:path"
import { parseArgs } from "node:util"
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import type {
  AgentCliHandle,
  AgentCliSetupStep,
  AgentCliSetupSkipIf,
  AgentCliSetupPersist,
} from "@agentproto/driver-agent-cli"
import { resolveAdapter } from "../registry/resolve.js"

interface LedgerEntry {
  /** Step id from the manifest. */
  stepId: string
  /** ISO-8601 timestamp the step succeeded (or was skipped via skip_if). */
  completedAt: string
  /** What kind of step this was — for forensic scrubbing. Persist values
   *  are NEVER stored in the ledger; only the slot name where they
   *  landed. */
  kind: AgentCliSetupStep["kind"]
  /** Slot the captured value went into, when applicable. Format:
   *   - `env:OPENCLAW_GATEWAY_URL`
   *   - `secret:openclaw/gateway-token`
   *   - `cmd`  (the value was piped to a config command, not stored here)
   */
  persistedTo?: string
  /** True when the step short-circuited via skip_if instead of running. */
  skippedViaSkipIf?: boolean
}

interface Ledger {
  /** Bundle id, matches the manifest's `id`. */
  slug: string
  /** When the ledger was last touched. */
  updatedAt: string
  /** One per step id. Most recent run wins. */
  steps: Record<string, LedgerEntry>
  /** Captured env-bound values — persist.env steps land here. The
   *  installer + runner read from the secrets backend in production;
   *  for the local CLI host we mirror them into the ledger so
   *  `agentproto run` can lift them onto the spawn env without hitting
   *  a remote vault. Restricted to 0600 perms by the writer. */
  envValues?: Record<string, string>
}

export interface RunSetupOptions {
  slug: string
  handle: AgentCliHandle
  /** When true, ignore the ledger AND skip_if; re-runs every step. */
  force?: boolean
  /** When true, log what would happen but don't spawn / prompt. */
  dryRun?: boolean
  /** When set, only run the named step ids (in declared order). Useful
   *  for re-running a single step after a manual fix. */
  only?: string[]
}

export async function runSetup(opts: RunSetupOptions): Promise<number> {
  const steps = opts.handle.setup ?? []
  if (steps.length === 0) {
    process.stdout.write(`agentproto setup: no setup steps for '${opts.slug}'.\n`)
    return 0
  }

  const ledgerPath = ledgerPathFor(opts.slug)
  const ledger = await loadLedger(ledgerPath, opts.slug)
  const onlySet = opts.only && opts.only.length > 0 ? new Set(opts.only) : null

  for (const [i, step] of steps.entries()) {
    if (onlySet && !onlySet.has(step.id)) continue

    const idx = `[${i + 1}/${steps.length}]`
    const head = `${idx} ${step.kind}/${step.id}`

    // Layer 3: ledger short-circuit (skipped on --force).
    const prev = ledger.steps[step.id]
    if (!opts.force && prev) {
      process.stdout.write(
        `${head} ✓ already completed (${prev.completedAt}${prev.skippedViaSkipIf ? ", via skip_if" : ""}). Pass --force to re-run.\n`
      )
      continue
    }

    // Layer 2: per-step skip_if.
    if (step.skip_if && !opts.force) {
      const ok = await checkSkipIf(step.skip_if)
      if (ok) {
        process.stdout.write(`${head} ✓ skip_if matched — skipping.\n`)
        ledger.steps[step.id] = {
          stepId: step.id,
          kind: step.kind,
          completedAt: new Date().toISOString(),
          skippedViaSkipIf: true,
        }
        continue
      }
    }

    if (opts.dryRun) {
      process.stdout.write(`${head} (dry-run) — would execute.\n`)
      continue
    }

    // Run the step.
    let entry: LedgerEntry | null = null
    try {
      switch (step.kind) {
        case "cmd":
          entry = await runCmdStep(step, ledger, head)
          break
        case "prompt":
          entry = await runPromptStep(step, ledger, head)
          break
        case "external":
          entry = await runExternalStep(step, ledger, head)
          break
        case "oauth":
          process.stderr.write(
            `${head} ✗ kind=oauth is not yet implemented in the local CLI host. ` +
              `Run the OAuth flow on the host that ships a SECRETS.md driver, then re-invoke.\n`
          )
          return 1
      }
    } catch (err) {
      process.stderr.write(
        `${head} ✗ failed: ${err instanceof Error ? err.message : String(err)}\n`
      )
      await saveLedger(ledgerPath, ledger)
      return 1
    }

    if (entry) {
      ledger.steps[step.id] = entry
      // Persist incrementally so a later step's failure doesn't lose
      // earlier successes (avoids re-prompting on next run).
      await saveLedger(ledgerPath, ledger)
    }
  }

  process.stdout.write(`agentproto: setup for '${opts.slug}' complete.\n`)
  return 0
}

/**
 * `agentproto setup <slug>` — re-run the setup pipeline for an
 * already-installed bundle. Useful when adding new steps to an
 * adapter, fixing a broken step, or after a `--skip-setup` install.
 */
export async function runSetupCommand(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      force: { type: "boolean", short: "f" },
      "dry-run": { type: "boolean" },
      only: { type: "string", multiple: true },
    },
  })
  const slug = positionals[0]
  if (!slug) {
    process.stderr.write(
      "agentproto setup: missing adapter slug. Try: agentproto setup openclaw\n"
    )
    return 2
  }
  const adapter = await resolveAdapter(slug)
  return runSetup({
    slug,
    handle: adapter.handle,
    force: values.force ?? false,
    dryRun: values["dry-run"] ?? false,
    ...(values.only ? { only: values.only } : {}),
  })
}

// ── Step runners ─────────────────────────────────────────────────────

async function runCmdStep(
  step: Extract<AgentCliSetupStep, { kind: "cmd" }>,
  ledger: Ledger,
  head: string
): Promise<LedgerEntry> {
  if (step.description) process.stdout.write(`${head} ${step.description}\n`)
  process.stdout.write(`${head} $ ${step.cmd}\n`)
  const captured = await runShellCapturing(step.cmd, {
    timeoutMs: step.timeout_ms ?? 60_000,
    interactive: step.interactive ?? false,
  })
  if (captured.exitCode !== 0) {
    throw new Error(
      `cmd exited ${captured.exitCode}${captured.stderr ? ": " + truncate(captured.stderr, 400) : ""}`
    )
  }
  // Persist the trimmed stdout when the step asks for it.
  let persistedTo: string | undefined
  if (step.persist) {
    const value = captured.stdout.trim()
    persistedTo = await applyPersist(step.persist, value, ledger)
  }
  return {
    stepId: step.id,
    kind: step.kind,
    completedAt: new Date().toISOString(),
    ...(persistedTo ? { persistedTo } : {}),
  }
}

async function runPromptStep(
  step: Extract<AgentCliSetupStep, { kind: "prompt" }>,
  ledger: Ledger,
  head: string
): Promise<LedgerEntry> {
  if (step.description) process.stdout.write(`${head} ${step.description}\n`)
  const type = step.type ?? "text"

  let value: string
  switch (type) {
    case "text":
    case "secret":
      value = await promptString(step.prompt, {
        defaultValue: step.default,
        masked: type === "secret",
      })
      break
    case "boolean":
      value = (await promptBoolean(step.prompt, step.default === "true"))
        ? "true"
        : "false"
      break
    case "select": {
      const options = await resolveSelectOptions(step.options)
      if (options.length === 0) {
        throw new Error("select prompt has no options to choose from")
      }
      value = await promptSelect(step.prompt, options, step.default)
      break
    }
  }

  let persistedTo: string | undefined
  if (step.persist) {
    persistedTo = await applyPersist(step.persist, value, ledger)
  }

  return {
    stepId: step.id,
    kind: step.kind,
    completedAt: new Date().toISOString(),
    ...(persistedTo ? { persistedTo } : {}),
  }
}

async function runExternalStep(
  step: Extract<AgentCliSetupStep, { kind: "external" }>,
  ledger: Ledger,
  head: string
): Promise<LedgerEntry> {
  if (step.description) process.stdout.write(`${head} ${step.description}\n`)
  process.stdout.write(`${head} opening ${step.url}\n`)
  const opener =
    platform() === "darwin"
      ? "open"
      : platform() === "win32"
        ? "cmd"
        : "xdg-open"
  const args = platform() === "win32" ? ["/c", "start", step.url] : [step.url]
  await new Promise<void>((resolve) => {
    const child = spawn(opener, args, { stdio: "ignore", detached: true })
    child.once("error", () => resolve()) // best-effort
    child.once("spawn", () => resolve())
  })

  // Callback polling (a host-allocated callback URL holding the result)
  // requires a local HTTP listener, which is reasonable in some hosts
  // but overkill for the agentproto CLI in v0.1. For now we fall back
  // to "paste the result" when the step declares a callback param;
  // the URL was opened above to start the flow.
  let value = ""
  if (step.callback?.param) {
    value = await promptString(
      `Paste the value of '${step.callback.param}' from the redirect`,
      { masked: false }
    )
  } else {
    process.stdout.write(`${head} done — press Enter when finished.\n`)
    await promptString("(press Enter to continue)", { masked: false })
  }

  let persistedTo: string | undefined
  if (step.persist && value) {
    persistedTo = await applyPersist(step.persist, value, ledger)
  }
  return {
    stepId: step.id,
    kind: step.kind,
    completedAt: new Date().toISOString(),
    ...(persistedTo ? { persistedTo } : {}),
  }
}

// ── skip_if check ────────────────────────────────────────────────────

async function checkSkipIf(skip: AgentCliSetupSkipIf): Promise<boolean> {
  const expectedCode = skip.exit_code ?? 0
  const captured = await runShellCapturing(skip.cmd, {
    timeoutMs: skip.timeout_ms ?? 5_000,
    interactive: false,
  })
  return captured.exitCode === expectedCode
}

// ── persist (env / secret_slug / cmd) ────────────────────────────────

async function applyPersist(
  persist: AgentCliSetupPersist,
  value: string,
  ledger: Ledger
): Promise<string> {
  if ("env" in persist && persist.env) {
    if (!ledger.envValues) ledger.envValues = {}
    ledger.envValues[persist.env] = value
    return `env:${persist.env}`
  }
  if ("secret_slug" in persist && persist.secret_slug) {
    // The secrets backend is host-supplied. The local CLI host doesn't
    // ship one yet; we surface the slug so the operator can pipe the
    // value into their vault out-of-band. Recording the slug (NOT the
    // value) in the ledger is intentional — the ledger isn't a vault.
    process.stdout.write(
      `agentproto setup: store the prompted value in your secrets backend under slug '${persist.secret_slug}' ` +
        `(value not echoed; ledger records the slot only).\n`
    )
    return `secret:${persist.secret_slug}`
  }
  if ("cmd" in persist && persist.cmd) {
    const cmd = persist.cmd.replace(/\$\{value\}/g, shellEscape(value))
    const captured = await runShellCapturing(cmd, {
      timeoutMs: 60_000,
      interactive: false,
    })
    if (captured.exitCode !== 0) {
      throw new Error(`persist cmd exited ${captured.exitCode}`)
    }
    return "cmd"
  }
  throw new Error("persist block must declare exactly one of env / secret_slug / cmd")
}

// ── prompt helpers ───────────────────────────────────────────────────

async function promptString(
  question: string,
  opts: { defaultValue?: string; masked?: boolean }
): Promise<string> {
  // Node's readline doesn't natively mask; for `masked: true` we set
  // the terminal to no-echo for the duration of the prompt. Best-effort
  // — some non-TTY environments fall back to plain input with a warning.
  const isTty = process.stdin.isTTY ?? false
  const suffix = opts.defaultValue ? ` [${opts.defaultValue}]` : ""
  const prompt = `${question}${suffix}: `
  if (opts.masked && !isTty) {
    process.stdout.write(
      `agentproto: stdin is not a TTY — masked input falls back to plain. Avoid piping secrets in non-interactive mode.\n`
    )
  }
  const rl = createInterface({ input, output, terminal: isTty })
  if (opts.masked && isTty) {
    // Toggle echo off via raw mode.
    process.stdin.setRawMode?.(true)
    let buf = ""
    process.stdout.write(prompt)
    return new Promise<string>((resolve) => {
      const onData = (chunk: Buffer) => {
        for (const code of chunk) {
          if (code === 0x0d /* CR */ || code === 0x0a /* LF */) {
            process.stdin.off("data", onData)
            process.stdin.setRawMode?.(false)
            process.stdout.write("\n")
            rl.close()
            resolve(buf || opts.defaultValue || "")
            return
          }
          if (code === 0x03 /* Ctrl-C */) {
            process.stdin.off("data", onData)
            process.stdin.setRawMode?.(false)
            rl.close()
            process.exit(130)
          }
          if (code === 0x7f /* DEL / backspace */ || code === 0x08) {
            buf = buf.slice(0, -1)
            continue
          }
          buf += String.fromCharCode(code)
          process.stdout.write("•")
        }
      }
      process.stdin.on("data", onData)
    })
  }
  try {
    const ans = (await rl.question(prompt)).trim()
    return ans || opts.defaultValue || ""
  } finally {
    rl.close()
  }
}

async function promptBoolean(
  question: string,
  defaultYes: boolean
): Promise<boolean> {
  const def = defaultYes ? "Y/n" : "y/N"
  const ans = await promptString(`${question} [${def}]`, { masked: false })
  if (!ans) return defaultYes
  return /^y(es)?$/i.test(ans)
}

async function promptSelect(
  question: string,
  options: { value: string; label?: string }[],
  defaultValue: string | undefined
): Promise<string> {
  process.stdout.write(`${question}\n`)
  for (const [i, o] of options.entries()) {
    const star =
      defaultValue && o.value === defaultValue ? "*" : i === 0 ? " " : " "
    process.stdout.write(
      `  ${star} ${i + 1}) ${o.label ?? o.value}${o.label ? ` (${o.value})` : ""}\n`
    )
  }
  const ans = await promptString(
    `Choose 1-${options.length}`,
    defaultValue ? { defaultValue } : { masked: false }
  )
  // Accept either the numeric index or a literal value.
  const asNum = Number.parseInt(ans, 10)
  if (Number.isFinite(asNum) && asNum >= 1 && asNum <= options.length) {
    return options[asNum - 1]!.value
  }
  const exact = options.find((o) => o.value === ans)
  if (exact) return exact.value
  if (defaultValue && options.some((o) => o.value === defaultValue)) {
    return defaultValue
  }
  throw new Error(
    `invalid selection '${ans}'; expected one of ${options.map((o) => o.value).join(", ")}`
  )
}

async function resolveSelectOptions(
  options: Extract<AgentCliSetupStep, { kind: "prompt" }>["options"]
): Promise<{ value: string; label?: string }[]> {
  if (!options) return []
  if (Array.isArray(options)) {
    return options.map((v) => ({ value: v }))
  }
  // Dynamic options: run the cmd, parse stdout (one option per line,
  // optional `value\tlabel`).
  const captured = await runShellCapturing(options.cmd, {
    timeoutMs: options.timeout_ms ?? 30_000,
    interactive: false,
  })
  if (captured.exitCode !== 0) {
    throw new Error(
      `select options cmd exited ${captured.exitCode}: ${truncate(captured.stderr, 400)}`
    )
  }
  return captured.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, label] = line.split("\t")
      const out: { value: string; label?: string } = { value: value! }
      if (label) out.label = label
      return out
    })
}

// ── shell helper ─────────────────────────────────────────────────────

async function runShellCapturing(
  cmd: string,
  opts: { timeoutMs: number; interactive: boolean }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd], {
      stdio: opts.interactive
        ? "inherit"
        : ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8")
    })
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8")
    })
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 1000)
    }, opts.timeoutMs)
    child.once("error", () => {
      clearTimeout(timer)
      resolve({ exitCode: 127, stdout, stderr: stderr || "spawn error" })
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? 0, stdout, stderr })
    })
  })
}

function shellEscape(s: string): string {
  // POSIX-style single-quote escape — wraps in single quotes and
  // closes/reopens around any literal single quote in the value.
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "…"
}

// ── ledger ───────────────────────────────────────────────────────────

function ledgerPathFor(slug: string): string {
  const base =
    process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  return join(base, "setup", `${slug}.json`)
}

async function loadLedger(path: string, slug: string): Promise<Ledger> {
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as Ledger
    if (parsed.slug === slug && typeof parsed.steps === "object") return parsed
  } catch {
    // No ledger yet, or malformed — start fresh.
  }
  return {
    slug,
    updatedAt: new Date().toISOString(),
    steps: {},
  }
}

async function saveLedger(path: string, ledger: Ledger): Promise<void> {
  ledger.updatedAt = new Date().toISOString()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(ledger, null, 2))
  await chmod(path, 0o600).catch(() => {
    // chmod failures on Windows are non-fatal — the file lives in
    // %USERPROFILE% which is already user-private.
  })
}
