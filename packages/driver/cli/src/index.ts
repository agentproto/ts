/**
 * @agentproto/cli — AIP-29 CLI provider specialisation.
 *
 * Wraps a CLI binary as a conformant provider: subprocess spawn,
 * argv templating with `${input.X}` substitution + filters
 * (`default`, `optional`, `flag`), exit-code → semantic error
 * mapping, JSON / text output parsing.
 *
 * v0.1 covers spawn + argv templating + output parsing.
 * **Sandbox enforcement** (network egress allowlist, fs read/write/deny,
 * exec.spawn, env scrubbing, TTY allocation) is OS-level policy that
 * the host integrates via platform primitives (Linux seccomp, macOS
 * sandbox-exec, container network policy). The bundle DECLARES the
 * sandbox in DRIVER.md frontmatter; v0.2 will wire enforcement.
 *
 * Spec: https://agentproto.sh/docs/aip-29
 */

import { spawn } from "node:child_process"
import {
  defineDriver,
  type ExecuteFn,
  type ImplementsEntry,
  type DriverDefinition,
  type DriverHandle,
} from "@agentproto/driver"

export interface CliDriverDefinition
  extends Omit<DriverDefinition, "kind" | "execute"> {
  kind?: "cli"
  /** Binary name on $PATH, or workspace-relative path. */
  bin: string
  /** Default argv prefix injected before per-tool argv. */
  binArgs?: readonly string[]
  /** Output parsing convention. */
  output?: {
    defaultFormat?: "text" | "json" | "yaml" | "binary"
    jsonFlag?: string
    jsonFlagArgs?: readonly string[]
    exitCodes?: Record<number, string>
    stream?: "stdout" | "stderr" | "mixed"
    errorStream?: "stdout" | "stderr" | "mixed"
  }
  /** TTY requirement. */
  tty?: { required?: boolean }
  /** Optional sandbox declaration; enforcement is host policy. */
  sandbox?: {
    fs?: { read?: readonly string[]; write?: readonly string[]; deny?: readonly string[] }
    exec?: { allow?: boolean; spawn?: readonly string[] }
    env?: { pass?: readonly string[]; set?: Record<string, string> }
  }
}

/**
 * Define a CLI provider — sugar over defineDriver with kind: cli
 * and an auto-synthesised execute map.
 */
export function defineCliDriver(definition: CliDriverDefinition): DriverHandle {
  const execute: Record<string, ExecuteFn> = {}
  for (const entry of definition.implements) {
    const toolId = normalizeToolId(entry.tool)
    execute[toolId] = createExecuteFn({
      toolId,
      entry,
      bin: definition.bin,
      binArgs: definition.binArgs ?? [],
      output: definition.output ?? {},
      sandbox: definition.sandbox,
    })
  }

  return defineDriver({
    ...definition,
    kind: "cli",
    execute,
    metadata: {
      ...(definition.metadata ?? {}),
      cli: {
        bin: definition.bin,
        binArgs: definition.binArgs,
        output: definition.output,
        tty: definition.tty,
        sandbox: definition.sandbox,
      },
    },
  })
}

function createExecuteFn(args: {
  toolId: string
  entry: ImplementsEntry
  bin: string
  binArgs: readonly string[]
  output: NonNullable<CliDriverDefinition["output"]>
  sandbox: CliDriverDefinition["sandbox"]
}): ExecuteFn {
  const meta = (args.entry.metadata ?? {}) as { cli?: PerToolCli }
  const cliMeta = meta.cli ?? {}

  return async ({ input, context, driverCtx, signal }) => {
    const inputObj = (input ?? {}) as Record<string, unknown>
    const ctxObj = context as Record<string, unknown>
    const provCtx = driverCtx as { secrets: Record<string, string>; [k: string]: unknown }
    void ctxObj

    const argvTemplate = cliMeta.argv ?? []
    const argv = expandArgv(argvTemplate, {
      input: inputObj,
      secrets: provCtx.secrets ?? {},
    })

    const result = await runSubprocess({
      bin: args.bin,
      argv: [...args.binArgs, ...argv],
      env: buildEnv(args.sandbox?.env, provCtx.secrets ?? {}),
      signal,
    })

    return parseOutput({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      output: args.output,
      cliMeta,
    })
  }
}

interface PerToolCli {
  argv?: readonly string[]
  outputFormat?: "text" | "json" | "yaml" | "binary"
  outputJsonFlag?: readonly string[]
}

interface SubprocessResult {
  exitCode: number
  stdout: string
  stderr: string
}

async function runSubprocess(args: {
  bin: string
  argv: readonly string[]
  env: Record<string, string>
  signal: AbortSignal
}): Promise<SubprocessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(args.bin, [...args.argv], {
      env: args.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", chunk => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString()
    })

    const onAbort = () => {
      child.kill("SIGTERM")
    }
    if (args.signal.aborted) {
      child.kill("SIGTERM")
    } else {
      args.signal.addEventListener("abort", onAbort, { once: true })
    }

    child.on("error", err => {
      args.signal.removeEventListener("abort", onAbort)
      reject(new CliDriverError("upstream_error", err.message))
    })

    child.on("close", code => {
      args.signal.removeEventListener("abort", onAbort)
      resolve({ exitCode: code ?? 0, stdout, stderr })
    })
  })
}

function parseOutput(args: {
  exitCode: number
  stdout: string
  stderr: string
  output: NonNullable<CliDriverDefinition["output"]>
  cliMeta: PerToolCli
}): unknown {
  const exitCodes = args.output.exitCodes ?? { 0: "ok" }
  const semantic = exitCodes[args.exitCode]

  if (semantic === "ok" || (args.exitCode === 0 && !semantic)) {
    const format = args.cliMeta.outputFormat ?? args.output.defaultFormat ?? "text"
    if (format === "json") {
      try {
        return JSON.parse(args.stdout)
      } catch (err) {
        throw new CliDriverError(
          "output_parse_failed",
          `JSON parse failed: ${(err as Error).message}`
        )
      }
    }
    return args.stdout
  }

  if (semantic === "auth_required") {
    throw new CliDriverError("auth_required", args.stderr.trim() || "auth required")
  }
  if (semantic === "rate_limited" || semantic === "rate-limited") {
    throw new CliDriverError("rate_limited", args.stderr.trim() || "rate limited", true)
  }
  throw new CliDriverError(
    semantic ?? "upstream_error",
    args.stderr.trim() || `exit code ${args.exitCode}`,
    args.exitCode >= 500
  )
}

class CliDriverError extends Error {
  code: string
  retryable?: boolean
  constructor(code: string, message: string, retryable?: boolean) {
    super(message)
    this.name = "CliDriverError"
    this.code = code
    this.retryable = retryable
  }
}

/** Expand argv template tokens against input + secrets. */
export function expandArgv(
  template: readonly string[],
  vars: { input: Record<string, unknown>; secrets: Record<string, string> }
): string[] {
  const out: string[] = []
  for (const token of template) {
    const expanded = expandToken(token, vars)
    if (expanded === SKIP_TOKEN) continue
    if (Array.isArray(expanded)) out.push(...expanded.map(String))
    else if (expanded !== undefined) out.push(String(expanded))
  }
  return out
}

const SKIP_TOKEN = Symbol("skip")

function expandToken(
  token: string,
  vars: { input: Record<string, unknown>; secrets: Record<string, string> }
): unknown {
  // Simple substitution.
  const single = token.match(/^\$\{(input|secrets)\.([\w.]+)\}$/)
  if (single) {
    const [, scope, path] = single
    const value = resolvePath(vars[scope as "input" | "secrets"], path!)
    return value === undefined ? SKIP_TOKEN : value
  }
  // Filter syntax: ${input.X | filter(args)}
  const filtered = token.match(/^\$\{(input|secrets)\.([\w.]+)\s*\|\s*(\w+)\(([^)]*)\)\}$/)
  if (filtered) {
    const [, scope, path, filter, argRaw] = filtered
    const value = resolvePath(vars[scope as "input" | "secrets"], path!)
    return applyFilter(filter!, value, argRaw!.trim(), token)
  }
  // Multi-substitution / literal mix.
  return token.replace(
    /\$\{(input|secrets)\.([\w.]+)\}/g,
    (_m, scope: string, path: string) => {
      const v = resolvePath(vars[scope as "input" | "secrets"], path)
      return v === undefined || v === null ? "" : String(v)
    }
  )
}

function applyFilter(
  filter: string,
  value: unknown,
  arg: string,
  originalToken: string
): unknown {
  switch (filter) {
    case "default":
      return value !== undefined && value !== null ? value : stripQuotes(arg)
    case "optional":
      // ${input.X | optional('--flag', input.X)}
      // When X is set, emit [arg-flag, X]; when not, skip.
      if (value === undefined || value === null) return SKIP_TOKEN
      // arg is "'--flag', input.X" — we crudely take the first quoted token as the flag.
      const flagMatch = arg.match(/^['"](.+?)['"]/)
      const flag = flagMatch ? flagMatch[1]! : arg.split(",")[0]!.trim()
      return [flag, String(value)]
    case "flag":
      // ${input.X | flag('--draft')} — append flag when X is truthy.
      if (!value) return SKIP_TOKEN
      return stripQuotes(arg)
    case "json":
      return JSON.stringify(value)
    default:
      // Unknown filter — fall through to substitution.
      void originalToken
      return value === undefined ? "" : String(value)
  }
}

function stripQuotes(s: string): string {
  const t = s.trim()
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1)
  }
  return t
}

function resolvePath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key]
    return undefined
  }, obj)
}

function buildEnv(
  envConfig: NonNullable<CliDriverDefinition["sandbox"]>["env"] | undefined,
  secrets: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  // Pass through declared env vars from host.
  for (const key of envConfig?.pass ?? []) {
    if (process.env[key] !== undefined) out[key] = process.env[key]!
  }
  // Inject resolved secrets that match passed env names.
  for (const key of envConfig?.pass ?? []) {
    if (secrets[key] !== undefined) out[key] = secrets[key]!
  }
  // Apply forced env from sandbox.env.set.
  for (const [k, v] of Object.entries(envConfig?.set ?? {})) {
    out[k] = v
  }
  return out
}

function normalizeToolId(ref: string): string {
  let s = ref.trim()
  if (s.startsWith("./")) s = s.slice(2)
  if (s.endsWith("/TOOL.md")) s = s.slice(0, -"/TOOL.md".length)
  if (s.startsWith("tools/")) s = s.slice("tools/".length)
  const lastSlash = s.lastIndexOf("/")
  return lastSlash === -1 ? s : s.slice(lastSlash + 1)
}

export { CliDriverError }
