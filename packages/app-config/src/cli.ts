/**
 * Minimal CLI over a kit instance file. An app's `verify.command` can be a
 * tiny script that calls `runCli` (or the `app-config` bin) with its
 * `app.config.ts` exporting the kit plus optional verify inputs.
 *
 * Subcommands:
 *   check                load + validate app.yaml and every item file
 *   schema               writeSchemas(<root>/schemas)
 *   contracts [--check]  write contract files, or report drift
 *   verify               compose rules + contracts.check + scopes → report (exit 1 on error findings)
 *
 * Config module shape (app.config.ts):
 *   export const kit = defineAppConfig({...})
 *   export const rules?: GateRule[]
 *   export const template?: (item) => object
 *   export const contractsDir?: string
 *   export const scopes?: Record<string, ScopeFn>
 *
 * Run with `node --experimental-strip-types bin/app-config.mjs <cmd> app.config.ts`
 * (Node ≥22.6) or through tsx/vitest — anywhere the TS file can be imported.
 */
import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { isPlainObject, AppConfigError } from "./merge.js"
import {
  DEFAULT_CONTRACTS_DIR,
  type AnyKit,
  type ContractDrift,
  type GateRule,
  type Resolved,
  type ResolvedItem,
  type ScopeFn,
  type VerifyReport,
} from "./define.js"

type LooseItem = ResolvedItem<Record<string, unknown>>

export interface CliModule {
  kit: AnyKit
  rules?: readonly GateRule[]
  template?: (item: LooseItem) => object
  contractsDir?: string
  scopes?: Record<string, ScopeFn>
}

interface CliOptions {
  /** cwd for relative config paths; default process.cwd(). */
  cwd?: string
  /** argv without the node/script prefix; default process.argv.slice(2). */
  argv?: readonly string[]
  log?: (line: string) => void
}

const USAGE = `usage: app-config <check|schema|contracts|verify> [--root <dir>] [--check] [--contracts-dir <dir>] <app.config.ts>`

// Runtime guards — the config module arrives as `unknown` from a dynamic
// import; these narrow it without a single `as`.
function isKitLike(v: unknown): v is AnyKit {
  return (
    isPlainObject(v) &&
    typeof v["load"] === "function" &&
    typeof v["verify"] === "function" &&
    typeof v["jsonSchemas"] === "function"
  )
}

function isTemplateFn(v: unknown): v is (item: LooseItem) => object {
  return typeof v === "function"
}

function isScopeFn(v: unknown): v is ScopeFn {
  return typeof v === "function"
}

async function readCliModule(configPath: string): Promise<CliModule> {
  const mod: unknown = await import(configPath)
  if (!isPlainObject(mod)) {
    throw new AppConfigError(`config module ${configPath} has no exports object`)
  }
  const kit = mod["kit"]
  if (!isKitLike(kit)) {
    throw new AppConfigError(
      `config module ${configPath} must export "kit" (the value returned by defineAppConfig)`,
    )
  }
  const out: CliModule = { kit }
  const rules = mod["rules"]
  if (rules !== undefined) {
    if (!Array.isArray(rules)) throw new AppConfigError(`"rules" export must be an array`)
    out.rules = rules
  }
  const template = mod["template"]
  if (template !== undefined) {
    if (!isTemplateFn(template)) throw new AppConfigError(`"template" export must be a function`)
    out.template = template
  }
  const contractsDir = mod["contractsDir"]
  if (contractsDir !== undefined) {
    if (typeof contractsDir !== "string") throw new AppConfigError(`"contractsDir" export must be a string`)
    out.contractsDir = contractsDir
  }
  const scopes = mod["scopes"]
  if (scopes !== undefined) {
    if (!isPlainObject(scopes)) throw new AppConfigError(`"scopes" export must be an object`)
    const fns: Record<string, ScopeFn> = {}
    for (const [k, v] of Object.entries(scopes)) {
      if (!isScopeFn(v)) throw new AppConfigError(`scopes.${k} must be a function`)
      fns[k] = v
    }
    out.scopes = fns
  }
  return out
}

function parseArgs(argv: readonly string[]): {
  command: string
  root: string | undefined
  check: boolean
  contractsDir: string | undefined
  configFile: string
} | null {
  let command: string | undefined
  let root: string | undefined
  let check = false
  let contractsDir: string | undefined
  let configFile: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--root") {
      i++
      root = argv[i]
    } else if (a === "--check") {
      check = true
    } else if (a === "--contracts-dir") {
      i++
      contractsDir = argv[i]
    } else if (a !== undefined && a.startsWith("-")) {
      return null
    } else if (a !== undefined && command === undefined) {
      command = a
    } else if (a !== undefined) {
      configFile = a
    }
  }
  if (command === undefined || configFile === undefined) return null
  return { command, root, check, contractsDir, configFile }
}

function reportLines(report: VerifyReport): string[] {
  return [
    ...report.findings.map(
      (f) => `[${f.scope}/${f.level}]${f.item !== undefined ? ` (${f.item})` : ""} ${f.message}`,
    ),
    `verify: ${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.skipped} skipped — ${report.ok ? "OK" : "FAILED"}`,
  ]
}

function driftLines(drift: readonly ContractDrift[]): string[] {
  if (drift.length === 0) return ["contracts: no drift"]
  return drift.map((d) => `contracts: ${d.file} ${d.reason === "missing" ? "missing on disk" : "drifted"}`)
}

/**
 * Run the CLI. Returns the process exit code: 0 ok, 1 drift/failed verify,
 * 2 usage/config error.
 */
export async function runCli(opts: CliOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => process.stdout.write(line + "\n"))
  const argv = opts.argv ?? process.argv.slice(2)
  const cwd = opts.cwd ?? process.cwd()
  const args = parseArgs(argv)
  if (args === null) {
    log(USAGE)
    return 2
  }
  const { command, root, check, contractsDir: contractsDirArg, configFile } = args
  if (command !== "check" && command !== "schema" && command !== "contracts" && command !== "verify") {
    log(USAGE)
    return 2
  }
  const configPath = isAbsolute(configFile) ? configFile : resolve(cwd, configFile)
  let mod: CliModule
  try {
    mod = await readCliModule(pathToFileURL(configPath).href)
  } catch (err) {
    log(`app-config: cannot load config module ${configFile}: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }
  const kit = mod.kit
  const rootDir = root !== undefined ? (isAbsolute(root) ? root : resolve(cwd, root)) : cwd

  try {
    if (command === "check") {
      const resolved = kit.load(rootDir)
      log(`app-config: ${resolved.order.length} item(s), app OK (${resolved.appFile})`)
      return 0
    }
    const resolved = kit.load(rootDir)
    if (command === "schema") {
      kit.writeSchemas(resolve(rootDir, "schemas"))
      log("app-config: wrote schemas/app.schema.json + schemas/item.schema.json")
      return 0
    }
    if (command === "contracts") {
      const dir = contractsDirArg ?? mod.contractsDir ?? resolve(rootDir, DEFAULT_CONTRACTS_DIR)
      const handle = kit.contracts({
        resolved,
        template: mod.template ?? (() => ({})),
        dir,
      })
      if (check) {
        const drift = handle.check()
        for (const line of driftLines(drift)) log(line)
        return drift.length === 0 ? 0 : 1
      }
      handle.write()
      log(`app-config: wrote ${resolved.order.length} contract(s) under ${dir}`)
      return 0
    }
    // verify
    const report = kit.verify(resolved, {
      rules: mod.rules,
      template: mod.template,
      contractsDir: contractsDirArg ?? mod.contractsDir,
      scopes: mod.scopes,
    })
    for (const line of reportLines(report)) log(line)
    return report.ok ? 0 : 1
  } catch (err) {
    log(`app-config: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }
}
