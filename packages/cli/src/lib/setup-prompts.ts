/**
 * Shared prompt engine extracted from `agentproto setup`.
 *
 * Provides `runSteps()` — the core step-loop, parameterised by a ledger
 * path — so it can be called from both `agentproto setup` (agent-cli handle)
 * and `agentproto browser install` (browser adapter config steps).
 *
 * The only difference from `runSetup()` in setup.ts is that the caller
 * supplies a `ledgerPath` directly instead of a slug.
 *
 * Idempotency layers (same as the original runSetup):
 *   1. Per-step `skip_if.cmd` — live system check.
 *   2. Ledger — `ledgerPath` JSON, records each completed step.
 */

import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises"
import { platform } from "node:os"
import { dirname } from "node:path"
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import type {
  AgentCliSetupStep,
  AgentCliSetupSkipIf,
  AgentCliSetupPersist,
} from "@agentproto/driver-agent-cli"

// ── Ledger ────────────────────────────────────────────────────────────────────

export interface LedgerEntry {
  stepId: string
  completedAt: string
  kind: AgentCliSetupStep["kind"]
  /** `env:<VAR>` | `secret:<slug>` | `cmd` */
  persistedTo?: string
  skippedViaSkipIf?: boolean
}

export interface Ledger {
  /** Bundle id / slug. */
  slug: string
  updatedAt: string
  steps: Record<string, LedgerEntry>
  /** Captured env-bound values (persist.env steps). 0600 perms by the writer. */
  envValues?: Record<string, string>
}

export async function loadLedger(ledgerPath: string, slug: string): Promise<Ledger> {
  try {
    const raw = await readFile(ledgerPath, "utf8")
    const parsed = JSON.parse(raw) as Ledger
    if (parsed.slug === slug && typeof parsed.steps === "object") return parsed
  } catch {
    // No ledger yet, or malformed — start fresh.
  }
  return { slug, updatedAt: new Date().toISOString(), steps: {} }
}

export async function saveLedger(ledgerPath: string, ledger: Ledger): Promise<void> {
  ledger.updatedAt = new Date().toISOString()
  await mkdir(dirname(ledgerPath), { recursive: true })
  await writeFile(ledgerPath, JSON.stringify(ledger, null, 2))
  await chmod(ledgerPath, 0o600).catch(() => {
    // chmod failures on Windows are non-fatal.
  })
}

// ── runSteps ──────────────────────────────────────────────────────────────────

export interface RunStepsOptions {
  /** Absolute path to the ledger JSON file for this adapter / slug. */
  ledgerPath: string
  /** Slug written into the ledger's `slug` field (for identity/audit). */
  slug: string
  steps: AgentCliSetupStep[]
  /** When true, ignore the ledger AND skip_if; re-runs every step. */
  force?: boolean
  /** When true, log what would happen but don't spawn / prompt. */
  dryRun?: boolean
  /** When set, only run the named step ids (in declared order). */
  only?: string[]
}

export async function runSteps(opts: RunStepsOptions): Promise<number> {
  const ledger = await loadLedger(opts.ledgerPath, opts.slug)
  const onlySet = opts.only && opts.only.length > 0 ? new Set(opts.only) : null

  for (const [i, step] of opts.steps.entries()) {
    if (onlySet && !onlySet.has(step.id)) continue

    const idx = `[${i + 1}/${opts.steps.length}]`
    const head = `${idx} ${step.kind}/${step.id}`

    const prev = ledger.steps[step.id]
    if (!opts.force && prev) {
      process.stdout.write(
        `${head} ✓ already completed (${prev.completedAt}${prev.skippedViaSkipIf ? ", via skip_if" : ""}). Pass --force to re-run.\n`
      )
      continue
    }

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
            `${head} ✗ kind=oauth is not yet implemented in the local CLI host.\n`
          )
          return 1
      }
    } catch (err) {
      process.stderr.write(
        `${head} ✗ failed: ${err instanceof Error ? err.message : String(err)}\n`
      )
      await saveLedger(opts.ledgerPath, ledger)
      return 1
    }

    if (entry) {
      ledger.steps[step.id] = entry
      await saveLedger(opts.ledgerPath, ledger)
    }
  }

  return 0
}

// ── Step runners ──────────────────────────────────────────────────────────────

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
      value = (await promptBoolean(step.prompt, step.default === "true")) ? "true" : "false"
      break
    case "select": {
      const options = await resolveSelectOptions(step.options)
      if (options.length === 0) throw new Error("select prompt has no options to choose from")
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
    platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open"
  const args = platform() === "win32" ? ["/c", "start", step.url] : [step.url]
  await new Promise<void>((resolve) => {
    const child = spawn(opener, args, { stdio: "ignore", detached: true })
    child.once("error", () => resolve())
    child.once("spawn", () => resolve())
  })

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

// ── skip_if ───────────────────────────────────────────────────────────────────

async function checkSkipIf(skip: AgentCliSetupSkipIf): Promise<boolean> {
  const expectedCode = skip.exit_code ?? 0
  const captured = await runShellCapturing(skip.cmd, {
    timeoutMs: skip.timeout_ms ?? 5_000,
    interactive: false,
  })
  return captured.exitCode === expectedCode
}

// ── persist ───────────────────────────────────────────────────────────────────

export async function applyPersist(
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
    process.stdout.write(
      `agentproto: store the prompted value in your secrets backend under slug '${persist.secret_slug}' ` +
        `(value not echoed; ledger records the slot only).\n`
    )
    return `secret:${persist.secret_slug}`
  }
  if ("cmd" in persist && persist.cmd) {
    const cmd = persist.cmd.replace(/\$\{value\}/g, shellEscape(value))
    const captured = await runShellCapturing(cmd, { timeoutMs: 60_000, interactive: false })
    if (captured.exitCode !== 0) throw new Error(`persist cmd exited ${captured.exitCode}`)
    return "cmd"
  }
  throw new Error("persist block must declare exactly one of env / secret_slug / cmd")
}

// ── prompt helpers ────────────────────────────────────────────────────────────

export async function promptString(
  question: string,
  opts: { defaultValue?: string; masked?: boolean }
): Promise<string> {
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
    process.stdin.setRawMode?.(true)
    let buf = ""
    process.stdout.write(prompt)
    return new Promise<string>((resolve) => {
      const onData = (chunk: Buffer) => {
        for (const code of chunk) {
          if (code === 0x0d || code === 0x0a) {
            process.stdin.off("data", onData)
            process.stdin.setRawMode?.(false)
            process.stdout.write("\n")
            rl.close()
            resolve(buf || opts.defaultValue || "")
            return
          }
          if (code === 0x03) {
            process.stdin.off("data", onData)
            process.stdin.setRawMode?.(false)
            rl.close()
            process.exit(130)
          }
          if (code === 0x7f || code === 0x08) { buf = buf.slice(0, -1); continue }
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

export async function promptBoolean(question: string, defaultYes: boolean): Promise<boolean> {
  const def = defaultYes ? "Y/n" : "y/N"
  const ans = await promptString(`${question} [${def}]`, { masked: false })
  if (!ans) return defaultYes
  return /^y(es)?$/i.test(ans)
}

export async function promptSelect(
  question: string,
  options: { value: string; label?: string }[],
  defaultValue: string | undefined
): Promise<string> {
  process.stdout.write(`${question}\n`)
  for (const [i, o] of options.entries()) {
    const star = defaultValue && o.value === defaultValue ? "*" : " "
    process.stdout.write(
      `  ${star} ${i + 1}) ${o.label ?? o.value}${o.label ? ` (${o.value})` : ""}\n`
    )
  }
  const ans = await promptString(
    `Choose 1-${options.length}`,
    defaultValue ? { defaultValue } : { masked: false }
  )
  const asNum = Number.parseInt(ans, 10)
  if (Number.isFinite(asNum) && asNum >= 1 && asNum <= options.length) {
    return options[asNum - 1]!.value
  }
  const exact = options.find((o) => o.value === ans)
  if (exact) return exact.value
  if (defaultValue && options.some((o) => o.value === defaultValue)) return defaultValue
  throw new Error(
    `invalid selection '${ans}'; expected one of ${options.map((o) => o.value).join(", ")}`
  )
}

async function resolveSelectOptions(
  options: Extract<AgentCliSetupStep, { kind: "prompt" }>["options"]
): Promise<{ value: string; label?: string }[]> {
  if (!options) return []
  if (Array.isArray(options)) return options.map((v) => ({ value: v }))
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

// ── shell helpers ─────────────────────────────────────────────────────────────

export async function runShellCapturing(
  cmd: string,
  opts: { timeoutMs: number; interactive: boolean }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd], {
      stdio: opts.interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8") })
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8") })
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
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "…"
}
