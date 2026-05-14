/**
 * `agentproto config <get|set|unset|edit|show> [args]`
 *
 * Hand-editable defaults at `~/.agentproto/config.json`. Sub-verbs:
 *
 *   show               dump the whole config (pretty JSON)
 *   get <key>          read one dot-notation key
 *   set <key> <value>  write one key. Value parsed as JSON when valid,
 *                      otherwise stored as a string. Arrays accept a
 *                      comma-separated form (`a,b,c`) for convenience.
 *   unset <key>        delete one key
 *   edit               open the file in $EDITOR (or vi)
 *   path               print the config file path (scripting helper)
 *
 * The daemon reads this file at boot — `serve` falls back to these
 * values when neither CLI flags nor env vars supply one. CLI flags
 * still win, so a config can hold sensible defaults without locking
 * out one-off overrides.
 */

import { parseArgs } from "node:util"
import { spawn } from "node:child_process"
import {
  loadConfig,
  saveConfig,
  getConfigKey,
  setConfigKey,
  CONFIG_FILE_PATH,
} from "@agentproto/runtime/config"

const USAGE = `agentproto config — manage ~/.agentproto/config.json

Usage:
  agentproto config show                 dump the full config as JSON
  agentproto config path                 print the config file path
  agentproto config get <key>            read one dot-notation key
  agentproto config set <key> <value>    write a key (JSON-parsed when valid)
  agentproto config unset <key>          delete a key
  agentproto config edit                 open the file in $EDITOR

Examples:
  agentproto config set daemon.port 18791
  agentproto config set daemon.allowedOrigins https://guilde.work,https://app.example.com
  agentproto config set tunnel.host wss://guilde.work/api/v1/agentproto/tunnel
  agentproto config get daemon.port
`

export async function runConfig(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    process.stdout.write(USAGE)
    return args.length === 0 ? 2 : 0
  }
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "show":
      return runShow(rest)
    case "path":
      return runPath()
    case "get":
      return runGet(rest)
    case "set":
      return runSet(rest)
    case "unset":
      return runUnset(rest)
    case "edit":
      return runEdit()
    default:
      process.stderr.write(
        `agentproto config: unknown sub-verb "${sub}".\n\n${USAGE}`,
      )
      return 2
  }
}

async function runShow(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean" } },
  })
  void values // json is the only output today, accept flag for forward-compat
  const cfg = await loadConfig()
  process.stdout.write(JSON.stringify(cfg, null, 2) + "\n")
  return 0
}

async function runPath(): Promise<number> {
  process.stdout.write(CONFIG_FILE_PATH() + "\n")
  return 0
}

async function runGet(args: readonly string[]): Promise<number> {
  const key = args[0]
  if (!key) {
    process.stderr.write(
      "agentproto config get: missing key.\n  Try: agentproto config get daemon.port\n",
    )
    return 2
  }
  const cfg = await loadConfig()
  const val = getConfigKey(cfg, key)
  if (val === undefined) {
    process.stderr.write(`agentproto config get: "${key}" not set\n`)
    return 1
  }
  process.stdout.write(JSON.stringify(val, null, 2) + "\n")
  return 0
}

async function runSet(args: readonly string[]): Promise<number> {
  const [key, ...valueParts] = args
  if (!key || valueParts.length === 0) {
    process.stderr.write(
      "agentproto config set: missing key and/or value.\n" +
        '  Try: agentproto config set daemon.port 18791\n' +
        '       agentproto config set daemon.allowedOrigins https://guilde.work,https://x.com\n',
    )
    return 2
  }
  // Joined back so `set key 1 2 3` (whitespace-split argv) becomes
  // "1 2 3" as a string — caller can quote at the shell to control.
  const raw = valueParts.join(" ")
  const parsed = parseValue(raw)
  const cfg = await loadConfig()
  const next = setConfigKey(cfg, key, parsed)
  await saveConfig(next)
  process.stdout.write(
    `agentproto config: set ${key} = ${JSON.stringify(parsed)}\n` +
      `  (${CONFIG_FILE_PATH()})\n`,
  )
  return 0
}

async function runUnset(args: readonly string[]): Promise<number> {
  const key = args[0]
  if (!key) {
    process.stderr.write(
      "agentproto config unset: missing key.\n  Try: agentproto config unset tunnel.host\n",
    )
    return 2
  }
  const cfg = await loadConfig()
  if (getConfigKey(cfg, key) === undefined) {
    process.stderr.write(`agentproto config unset: "${key}" not set\n`)
    return 0
  }
  const next = setConfigKey(cfg, key, undefined)
  await saveConfig(next)
  process.stdout.write(`agentproto config: unset ${key}\n`)
  return 0
}

async function runEdit(): Promise<number> {
  // First make sure the file exists — a non-existent file would fail
  // to open in some editors. saveConfig() with the current state is
  // a no-op write that materializes the file when missing.
  const cfg = await loadConfig()
  await saveConfig(cfg)
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi"
  return new Promise<number>(resolve => {
    const child = spawn(editor, [CONFIG_FILE_PATH()], {
      stdio: "inherit",
    })
    child.on("error", err => {
      process.stderr.write(
        `agentproto config edit: failed to launch ${editor}: ${err.message}\n`,
      )
      resolve(1)
    })
    child.on("exit", code => resolve(code ?? 0))
  })
}

/**
 * Parse a value string with these rules, in order:
 *   1. `true`, `false`, `null`  → corresponding JSON literal
 *   2. valid JSON               → parsed (numbers, arrays, objects)
 *   3. comma in value           → split into array of trimmed strings
 *   4. otherwise                → raw string
 *
 * Rationale: people set `daemon.port 18791` and expect a number, set
 * `daemon.allowedOrigins https://a.com,https://b.com` and expect a
 * string array — those are the two common cases. Quoting tricks via
 * JSON-literal mode (`'["a","b"]'`) are the escape hatch.
 */
function parseValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (trimmed === "null") return null
  // JSON first — covers numbers, arrays, objects, quoted strings.
  if (/^[\d\[{"-]/.test(trimmed) || trimmed === "true" || trimmed === "false") {
    try {
      return JSON.parse(trimmed)
    } catch {
      // fall through
    }
  }
  // CSV → string array (only when there's at least one unquoted comma).
  if (trimmed.includes(",") && !trimmed.startsWith('"')) {
    return trimmed.split(",").map(s => s.trim()).filter(Boolean)
  }
  return trimmed
}
