/**
 * `agentproto workspace <subcommand>`
 *
 * Subcommands:
 *   add <path> [--slug <slug>] [--label <text>]   register a folder
 *   list                                          show registered + active
 *   remove <slug>                                 drop an entry
 *   use <slug>                                    set the active workspace
 *
 * Reads/writes `~/.agentproto/workspaces.json` via @agentproto/runtime.
 * Pure CLI shell — no daemon needed; the daemon picks up the file on
 * its next read (boot for now, hot reload TBD).
 */
import { parseArgs } from "node:util"
import { resolve, basename } from "node:path"
import { existsSync } from "node:fs"
import {
  loadWorkspacesConfig,
  saveWorkspacesConfig,
  addWorkspace,
  removeWorkspace,
  setActiveWorkspace,
  sanitizeSlug,
  DEFAULT_CONFIG_PATH,
  type WorkspaceEntry,
} from "@agentproto/runtime/workspaces-config"

const USAGE = `agentproto workspace — manage local workspaces

Usage:
  agentproto workspace add <path> [--slug <slug>] [--label <text>]
  agentproto workspace list  [--json]
  agentproto workspace remove <slug>
  agentproto workspace use <slug>
  agentproto workspace --help

Config file: ${DEFAULT_CONFIG_PATH()}
`

export async function runWorkspace(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "add":
      return runAdd(rest)
    case "list":
    case "ls":
      return runList(rest)
    case "remove":
    case "rm":
      return runRemove(rest)
    case "use":
      return runUse(rest)
    default:
      process.stderr.write(
        `agentproto workspace: unknown subcommand '${sub}'\n\n${USAGE}`
      )
      return 2
  }
}

async function runAdd(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      slug: { type: "string" },
      label: { type: "string" },
    },
  })
  const rawPath = positionals[0]
  if (!rawPath) {
    process.stderr.write(
      "agentproto workspace add: missing <path>. Try: agentproto workspace add ~/code/my-project\n"
    )
    return 2
  }
  const absPath = resolve(rawPath.replace(/^~/, process.env.HOME ?? "~"))
  if (!existsSync(absPath)) {
    process.stderr.write(
      `agentproto workspace add: "${absPath}" doesn't exist. Create the directory first or pass an existing one.\n`
    )
    return 2
  }
  const slug = sanitizeSlug(values.slug ?? basename(absPath))
  const config = await loadWorkspacesConfig()
  const next = addWorkspace(config, {
    slug,
    path: absPath,
    ...(values.label ? { label: values.label } : {}),
  })
  await saveWorkspacesConfig(next)
  const wasActive = config.active === slug
  const becameActive = next.active === slug && !wasActive
  process.stdout.write(
    `✓ ${slug} → ${absPath}` +
      (becameActive ? "  (set as active — first registered workspace)" : "") +
      "\n"
  )
  return 0
}

async function runList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean" } },
  })
  const config = await loadWorkspacesConfig()
  if (values.json) {
    process.stdout.write(JSON.stringify(config, null, 2) + "\n")
    return 0
  }
  if (config.workspaces.length === 0) {
    process.stdout.write(
      "No workspaces registered.\n" +
        "Add one with: agentproto workspace add <path>\n"
    )
    return 0
  }
  // Compact two-column layout — slug left, path right, with an
  // active marker. Sorted by updatedAt desc so the most recently
  // touched workspace is at the top.
  const sorted = [...config.workspaces].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )
  const slugCol = Math.max(...sorted.map(w => w.slug.length), 6)
  for (const w of sorted) {
    const marker = w.slug === config.active ? "●" : " "
    const slugCell = w.slug.padEnd(slugCol)
    const labelSuffix = w.label ? `  (${w.label})` : ""
    process.stdout.write(
      `${marker} ${slugCell}  ${w.path}${labelSuffix}\n`
    )
  }
  process.stdout.write(
    `\n${sorted.length} workspace${sorted.length === 1 ? "" : "s"}` +
      (config.active ? `, active: ${config.active}` : ", no active") +
      "\n"
  )
  return 0
}

async function runRemove(args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {},
  })
  const slug = positionals[0]
  if (!slug) {
    process.stderr.write(
      "agentproto workspace remove: missing <slug>.\n"
    )
    return 2
  }
  const config = await loadWorkspacesConfig()
  const sanitised = sanitizeSlug(slug)
  const existed = config.workspaces.some(w => w.slug === sanitised)
  if (!existed) {
    process.stderr.write(
      `agentproto workspace remove: no workspace named "${sanitised}".\n`
    )
    return 2
  }
  const next = removeWorkspace(config, sanitised)
  await saveWorkspacesConfig(next)
  process.stdout.write(`✗ removed ${sanitised}\n`)
  if (next.active && next.active !== config.active) {
    process.stdout.write(`  active reassigned to: ${next.active}\n`)
  } else if (!next.active && config.active) {
    process.stdout.write(`  no workspaces left — active cleared\n`)
  }
  return 0
}

async function runUse(args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {},
  })
  const slug = positionals[0]
  if (!slug) {
    process.stderr.write("agentproto workspace use: missing <slug>.\n")
    return 2
  }
  const config = await loadWorkspacesConfig()
  try {
    const next = setActiveWorkspace(config, slug)
    await saveWorkspacesConfig(next)
    const w = next.workspaces.find(x => x.slug === next.active) as
      | WorkspaceEntry
      | undefined
    process.stdout.write(`● active: ${next.active}  (${w?.path ?? "?"})\n`)
    return 0
  } catch (err) {
    process.stderr.write(
      `agentproto workspace use: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    )
    return 2
  }
}
