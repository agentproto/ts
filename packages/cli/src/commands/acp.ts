/**
 * `agentproto acp <subcommand>`
 *
 * Manage generic ACP agents — any CLI that already speaks the Agent
 * Client Protocol, connectable with zero adapter code (see
 * ../registry/acp-generic.ts).
 *
 * Subcommands:
 *   ls                                    curated catalog + config agents, with status
 *   add <slug> --bin <bin> [--args …]     write a config.acpAgents entry
 *              [--name] [--desc] [--env]
 *              [--resumable]
 *   rm  <slug>                            remove a config.acpAgents entry
 *
 * `ls` reflects both the built-in `ACP_CATALOG` and the user's
 * `~/.agentproto/config.json` `acpAgents`; `add`/`rm` only ever touch the
 * config file — the curated catalog is read-only.
 */

import { parseArgs } from "node:util"
import {
  loadConfig,
  saveConfig,
  type AcpAgentConfigEntry,
} from "@agentproto/runtime/config"
import {
  ACP_CATALOG,
  acpHandleFromSpec,
  listAcpGenericAdapters,
} from "../registry/acp-generic.js"

const USAGE = `agentproto acp — manage generic ACP agents (zero-code ACP CLIs)

Usage:
  agentproto acp ls  [--json]
  agentproto acp add <slug> --bin <bin> [--args <arg>…] [--name <name>]
                            [--desc <text>] [--env <K=V>…] [--resumable] [--json]
  agentproto acp rm  <slug> [--json]
  agentproto acp --help

  ls   List the curated ACP catalog plus your config-defined agents, each
       with a status: 'available' (bin found on PATH) or 'supported'
       (not installed — shows the install hint).
  add  Register a generic ACP agent in ~/.agentproto/config.json. Any CLI
       that speaks ACP over stdio works — e.g. --bin gemini --args --experimental-acp.
       A config entry shadows a catalog entry of the same slug.
  rm   Remove one of your config-defined agents. Catalog entries can't be removed.

Examples:
  agentproto acp ls
  agentproto acp add my-agent --bin my-agent --args acp --resumable
  agentproto acp add gemini-cli --bin gemini --args --experimental-acp
  agentproto acp rm my-agent
`

export async function runAcp(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = args[0]
  if (sub === "ls" || sub === "list") return runLs(args.slice(1))
  if (sub === "add") return runAdd(args.slice(1))
  if (sub === "rm" || sub === "remove") return runRm(args.slice(1))

  if (!sub) {
    process.stdout.write(USAGE)
    return 0
  }
  process.stderr.write(
    `agentproto acp: unknown subcommand "${sub}"\n  Known: ls | add | rm\n`,
  )
  return 2
}

// ── ls ────────────────────────────────────────────────────────────────

async function runLs(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean" } },
  })

  const entries = await listAcpGenericAdapters()

  if (values.json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n")
    return 0
  }
  if (entries.length === 0) {
    process.stdout.write(
      "No generic ACP agents. Add one with `agentproto acp add <slug> --bin <bin>`.\n",
    )
    return 0
  }
  process.stdout.write(
    `${"SLUG".padEnd(16)}  ${"STATUS".padEnd(10)}  ${"SOURCE".padEnd(12)}  NAME\n`,
  )
  for (const e of entries) {
    process.stdout.write(
      `${e.slug.padEnd(16)}  ${e.status.padEnd(10)}  ${e.source.padEnd(12)}  ${e.name}\n`,
    )
    if (e.status === "supported" && e.hint) {
      process.stdout.write(`${" ".repeat(16)}  ↳ install: ${e.hint}\n`)
    }
  }
  return 0
}

// ── add ───────────────────────────────────────────────────────────────

async function runAdd(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      bin: { type: "string" },
      args: { type: "string", multiple: true },
      name: { type: "string" },
      desc: { type: "string" },
      env: { type: "string", multiple: true },
      resumable: { type: "boolean" },
      "install-hint": { type: "string" },
      json: { type: "boolean" },
    },
  })

  const slug = positionals[0]
  if (!slug) {
    process.stderr.write(
      "agentproto acp add: missing <slug>.\n" +
        "  Try: agentproto acp add my-agent --bin my-agent --args acp\n",
    )
    return 2
  }
  if (!values.bin) {
    process.stderr.write(
      `agentproto acp add: --bin is required (the executable to spawn for '${slug}').\n`,
    )
    return 2
  }

  let env: Record<string, string> | undefined
  if (values.env && values.env.length > 0) {
    env = {}
    for (const pair of values.env) {
      const eq = pair.indexOf("=")
      if (eq <= 0) {
        process.stderr.write(
          `agentproto acp add: --env expects K=V, got "${pair}".\n`,
        )
        return 2
      }
      env[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
  }

  const entry: AcpAgentConfigEntry = {
    bin: values.bin,
    ...(values.name ? { name: values.name } : {}),
    ...(values.desc ? { description: values.desc } : {}),
    ...(values.args && values.args.length > 0 ? { bin_args: values.args } : {}),
    ...(env ? { env } : {}),
    ...(values.resumable ? { resumable: true } : {}),
    ...(values["install-hint"] ? { install_hint: values["install-hint"] } : {}),
  }

  // Validate by minting the handle now (surfaces a bad slug / field with a
  // precise AIP-45 message before we ever write it to disk).
  try {
    acpHandleFromSpec({ ...entry, slug })
  } catch (err) {
    process.stderr.write(
      `agentproto acp add: invalid agent '${slug}': ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    )
    return 2
  }

  const cfg = await loadConfig()
  const acpAgents = { ...(cfg.acpAgents ?? {}) }
  const shadowsCatalog = ACP_CATALOG.some((e) => e.slug === slug)
  acpAgents[slug] = entry
  await saveConfig({ ...cfg, acpAgents })

  if (values.json) {
    process.stdout.write(
      JSON.stringify({ added: slug, entry, shadowsCatalog }, null, 2) + "\n",
    )
    return 0
  }
  process.stdout.write(`Added generic ACP agent '${slug}'.\n`)
  if (shadowsCatalog) {
    process.stdout.write(
      `  (shadows the curated catalog entry of the same slug)\n`,
    )
  }
  process.stdout.write(`  Run it with:  agentproto run ${slug} --prompt "..."\n`)
  return 0
}

// ── rm ────────────────────────────────────────────────────────────────

async function runRm(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { json: { type: "boolean" } },
  })

  const slug = positionals[0]
  if (!slug) {
    process.stderr.write("agentproto acp rm: missing <slug>.\n")
    return 2
  }

  const cfg = await loadConfig()
  if (!cfg.acpAgents || !(slug in cfg.acpAgents)) {
    const inCatalog = ACP_CATALOG.some((e) => e.slug === slug)
    process.stderr.write(
      inCatalog
        ? `agentproto acp rm: '${slug}' is a curated catalog entry — it has no config entry to remove.\n`
        : `agentproto acp rm: no config-defined agent '${slug}'.\n`,
    )
    return 1
  }

  const acpAgents = { ...cfg.acpAgents }
  delete acpAgents[slug]
  // Keep the key absent (not an empty object) when the last one is removed.
  const next = { ...cfg }
  if (Object.keys(acpAgents).length > 0) {
    next.acpAgents = acpAgents
  } else {
    delete next.acpAgents
  }
  await saveConfig(next)

  if (values.json) {
    process.stdout.write(JSON.stringify({ removed: slug }, null, 2) + "\n")
    return 0
  }
  process.stdout.write(`Removed generic ACP agent '${slug}'.\n`)
  return 0
}
