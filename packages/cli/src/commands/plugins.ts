/**
 * `agentproto plugins <subverb>` — manage runtime plugins.
 *
 *   plugins list                  Show enabled plugins + what they provide
 *   plugins show <pkg>            Print a plugin's manifest summary
 *   plugins install <pkg>         `npm i -g <pkg>` + add to config
 *   plugins uninstall <pkg>       Remove from config (+ optional npm rm)
 *   plugins enable <pkg>          Add to config (assumes installed)
 *   plugins disable <pkg>         Remove from config (keep installed)
 *
 * Plugin list lives in `~/.agentproto/config.json`:
 *
 *   { "plugins": ["@guilde/agentproto-bridge", "@acme/agentproto-slack"] }
 *
 * Plugins are loaded by `agentproto run-swarm` in the order they
 * appear. Last one to register a `kind` wins — useful for overriding
 * a built-in or another plugin's adapter.
 */

import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { readPluginManifest } from "../registry/manifest-loader.js"
import type {
  AdapterEntry,
  PluginManifest,
  SubstrateEntry,
} from "../registry/manifest.js"

const USAGE = `agentproto plugins — manage runtime plugins

Usage:
  agentproto plugins list                  Show enabled plugins + adapters
  agentproto plugins show <pkg>            Print a plugin's manifest
  agentproto plugins install <pkg>         npm i -g + add to config
  agentproto plugins uninstall <pkg>       Remove from config (+ npm rm)
  agentproto plugins enable <pkg>          Add to config (assume installed)
  agentproto plugins disable <pkg>         Remove from config (keep installed)
  agentproto plugins --help

Plugin list lives in ~/.agentproto/config.json under \`plugins[]\`.
`

export async function runPlugins(args: readonly string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case undefined:
    case "-h":
    case "--help":
      process.stdout.write(USAGE)
      return 0
    case "list":
      return runList(rest)
    case "show":
      return runShow(rest)
    case "install":
      return runInstall(rest)
    case "uninstall":
      return runUninstall(rest)
    case "enable":
      return runEnable(rest)
    case "disable":
      return runDisable(rest)
    default:
      process.stderr.write(
        `agentproto plugins: unknown subcommand '${sub}'.\n\n${USAGE}`
      )
      return 2
  }
}

// ── list ──────────────────────────────────────────────────────────────

async function runList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { json: { type: "boolean" } },
    strict: true,
  })
  const cfg = await loadConfig()
  const plugins = cfg.plugins ?? []
  if (plugins.length === 0) {
    if (values.json) process.stdout.write("[]\n")
    else
      process.stdout.write(
        "agentproto plugins: no plugins enabled. Try `agentproto plugins install <pkg>`.\n"
      )
    return 0
  }

  const entries: Array<{
    id: string
    manifest: PluginManifest | null
    error?: string
  }> = []
  for (const id of plugins) {
    try {
      const result = await readPluginManifest(id)
      entries.push({ id, manifest: result?.manifest ?? null })
    } catch (err) {
      entries.push({
        id,
        manifest: null,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`)
    return 0
  }

  for (const e of entries) {
    process.stdout.write(`• ${e.id}\n`)
    if (e.error) {
      process.stdout.write(`    error: ${e.error}\n`)
      continue
    }
    if (!e.manifest) {
      process.stdout.write(`    (no manifest — legacy side-effect plugin)\n`)
      continue
    }
    printAdapterSummary("substrates", e.manifest.substrates)
    printAdapterSummary("dispatchers", e.manifest.dispatchers)
    printAdapterSummary("executors", e.manifest.executors)
    printAdapterSummary("state stores", e.manifest.stateStores)
  }
  return 0
}

function printAdapterSummary(
  label: string,
  entries: ReadonlyArray<AdapterEntry | SubstrateEntry>
): void {
  if (entries.length === 0) return
  const kinds = entries.map((e) => e.kind).join(", ")
  process.stdout.write(`    ${label}: ${kinds}\n`)
}

// ── show ──────────────────────────────────────────────────────────────

async function runShow(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { json: { type: "boolean" } },
    strict: true,
  })
  const pkg = positionals[0]
  if (!pkg) {
    process.stderr.write(
      "agentproto plugins show: missing <pkg>. Try: agentproto plugins show @guilde/agentproto-bridge\n"
    )
    return 2
  }

  let result: Awaited<ReturnType<typeof readPluginManifest>>
  try {
    result = await readPluginManifest(pkg)
  } catch (err) {
    process.stderr.write(
      `agentproto plugins show: ${err instanceof Error ? err.message : String(err)}\n`
    )
    return 1
  }
  if (!result) {
    process.stderr.write(
      `agentproto plugins show: '${pkg}' is not installed (or doesn't declare an agentproto manifest).\n`
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`)
    return 0
  }

  const m = result.manifest
  process.stdout.write(`${pkg}\n`)
  process.stdout.write(`  schema: ${m.schema}\n`)
  printAdapterDetail("substrates", m.substrates)
  printAdapterDetail("dispatchers", m.dispatchers)
  printAdapterDetail("executors", m.executors)
  printAdapterDetail("state stores", m.stateStores)
  return 0
}

function printAdapterDetail(
  label: string,
  entries: ReadonlyArray<AdapterEntry | SubstrateEntry>
): void {
  if (entries.length === 0) return
  process.stdout.write(`  ${label}:\n`)
  for (const e of entries) {
    process.stdout.write(`    • kind: ${e.kind}\n`)
    process.stdout.write(`      entry: ${e.entry} → ${e.export}\n`)
    const caps = "capabilities" in e ? e.capabilities : undefined
    if (Array.isArray(caps) && caps.length > 0) {
      process.stdout.write(`      capabilities: ${caps.join(", ")}\n`)
    }
    if (e.description) {
      process.stdout.write(`      ${e.description}\n`)
    }
  }
}

// ── install / uninstall / enable / disable ────────────────────────────

async function runInstall(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      local: { type: "boolean" },
      "skip-npm": { type: "boolean" },
    },
    strict: true,
  })
  const pkg = positionals[0]
  if (!pkg) {
    process.stderr.write("agentproto plugins install: missing <pkg>.\n")
    return 2
  }

  if (!values["skip-npm"]) {
    const code = await spawnInherit("npm", [
      "install",
      values.local ? "" : "-g",
      pkg,
    ].filter(Boolean))
    if (code !== 0) {
      process.stderr.write(
        `agentproto plugins install: npm failed with exit ${code}; config not modified.\n`
      )
      return code
    }
  }

  await addToConfig(pkg)
  process.stdout.write(`agentproto plugins: enabled '${pkg}'.\n`)
  return 0
}

async function runUninstall(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      local: { type: "boolean" },
      "skip-npm": { type: "boolean" },
    },
    strict: true,
  })
  const pkg = positionals[0]
  if (!pkg) {
    process.stderr.write("agentproto plugins uninstall: missing <pkg>.\n")
    return 2
  }

  await removeFromConfig(pkg)

  if (!values["skip-npm"]) {
    const code = await spawnInherit("npm", [
      "uninstall",
      values.local ? "" : "-g",
      pkg,
    ].filter(Boolean))
    if (code !== 0) {
      process.stderr.write(
        `agentproto plugins uninstall: removed from config but npm uninstall failed with exit ${code}.\n`
      )
      return code
    }
  }

  process.stdout.write(`agentproto plugins: disabled '${pkg}'.\n`)
  return 0
}

async function runEnable(args: readonly string[]): Promise<number> {
  const [pkg] = args
  if (!pkg) {
    process.stderr.write("agentproto plugins enable: missing <pkg>.\n")
    return 2
  }
  await addToConfig(pkg)
  process.stdout.write(`agentproto plugins: enabled '${pkg}'.\n`)
  return 0
}

async function runDisable(args: readonly string[]): Promise<number> {
  const [pkg] = args
  if (!pkg) {
    process.stderr.write("agentproto plugins disable: missing <pkg>.\n")
    return 2
  }
  await removeFromConfig(pkg)
  process.stdout.write(`agentproto plugins: disabled '${pkg}'.\n`)
  return 0
}

// ── config helpers ────────────────────────────────────────────────────

interface AgentprotoConfig {
  plugins?: string[]
  [key: string]: unknown
}

function configPath(): string {
  const base = process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  return join(base, "config.json")
}

async function loadConfig(): Promise<AgentprotoConfig> {
  try {
    const raw = await readFile(configPath(), "utf8")
    return JSON.parse(raw) as AgentprotoConfig
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw err
  }
}

async function saveConfig(cfg: AgentprotoConfig): Promise<void> {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`)
}

async function addToConfig(pkg: string): Promise<void> {
  const cfg = await loadConfig()
  const plugins = cfg.plugins ?? []
  if (!plugins.includes(pkg)) plugins.push(pkg)
  cfg.plugins = plugins
  await saveConfig(cfg)
}

async function removeFromConfig(pkg: string): Promise<void> {
  const cfg = await loadConfig()
  cfg.plugins = (cfg.plugins ?? []).filter((p) => p !== pkg)
  await saveConfig(cfg)
}

function spawnInherit(cmd: string, argv: string[]): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, argv, { stdio: "inherit" })
    child.once("error", rejectP)
    child.once("exit", (code) => resolveP(code ?? 0))
  })
}
