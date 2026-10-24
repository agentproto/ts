/**
 * `agentproto agent create <slug> [dir] [--force] [--model <id>] [--description <text>]`
 * `agentproto agent list [dir]`
 *
 * CREATE renders a valid AIP-42 `agent/v1` AGENT.md at
 * `<dir>/.agents/<slug>/AGENT.md` — the canonical hand-written layout
 * `loadAgent` / `self_inspect` read first — through the shared
 * `renderAgentManifest` (`@agentproto/app`), so a created manifest is
 * byte-identical to one `app emit` writes. It refuses to overwrite an
 * existing manifest unless `--force`.
 *
 * LIST is a plain read-side scan of `<dir>/.agents/`: every subdirectory
 * holding an AGENT.md is an agent, printed as `id -> path` (plus
 * `name`/`version` from the frontmatter when present).
 *
 * Neither verb needs a running daemon.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

import matter from "gray-matter"
import { renderAgentManifest } from "@agentproto/app"

import { pathExists } from "./skill-install/shared.js"
import { expandHome } from "./skill-install/pack-resolve.js"

const DEFAULT_MODEL = "claude-sonnet-5"

const USAGE = `agentproto agent — create and list AIP-42 agent manifests

Usage:
  agentproto agent create <slug> [dir] [--force] [--model <id>] [--description <text>]
  agentproto agent list [dir]

create:
  Render a valid agent/v1 AGENT.md at <dir>/.agents/<slug>/AGENT.md
  (<dir> defaults to the current directory). Refuses to overwrite an
  existing manifest unless --force. --model (default ${DEFAULT_MODEL}) and
  --description (default "Agent <slug>.") fill the frontmatter's model /
  description fields.

list:
  Print every agent discovered under <dir>/.agents/<id>/AGENT.md as
  "id -> path", with name/version appended when the frontmatter carries them.`

/** Dispatcher for `agentproto agent` — first non-flag token is the subverb. */
export async function runAgent(args: readonly string[]): Promise<number> {
  const subVerb = args.find((a) => !a.startsWith("-"))
  if (subVerb === "create") {
    return runAgentCreate(args.filter((a) => a !== subVerb))
  }
  if (subVerb === "list") {
    return runAgentList(args.filter((a) => a !== subVerb))
  }
  process.stderr.write(
    `agentproto agent: unknown sub-command${subVerb ? ` '${subVerb}'` : ""}.\n${USAGE}\n`,
  )
  return 1
}

/** `agentproto agent create <slug> [dir] [--force] [--model] [--description]`. */
export async function runAgentCreate(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      force: { type: "boolean" },
      model: { type: "string" },
      description: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const slug = positionals[0]
  if (!slug) {
    process.stderr.write(`agentproto agent create: <slug> is required.\n${USAGE}\n`)
    return 1
  }
  const dirArg = positionals[1] ?? "."
  const dir = resolve(process.cwd(), expandHome(dirArg))
  const force = values.force === true
  const model = typeof values.model === "string" && values.model.trim() !== "" ? values.model.trim() : DEFAULT_MODEL
  const description =
    typeof values.description === "string" && values.description.trim() !== ""
      ? values.description.trim()
      : `Agent ${slug}.`

  let rendered: { path: string; contents: string }
  try {
    rendered = renderAgentManifest(
      {
        schema: "agent/v1" as const,
        id: slug,
        description,
        model,
        tools: [],
        skills: [],
        workflows: [],
        routines: [],
      },
      "",
      { dir, layout: "canonical" },
    )
  } catch (err) {
    process.stderr.write(
      `agentproto agent create: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (!force && (await pathExists(rendered.path))) {
    process.stderr.write(
      `agentproto agent create: ${rendered.path} already exists (pass --force to overwrite).\n`,
    )
    return 1
  }

  await mkdir(dirname(rendered.path), { recursive: true })
  await writeFile(rendered.path, rendered.contents, "utf8")
  process.stdout.write(`agentproto: created agent '${slug}' -> ${rendered.path}\n`)
  return 0
}

/** One discovered agent, as read from the `.agents/<id>/AGENT.md` dir name
 *  and frontmatter. */
interface DiscoveredAgent {
  readonly id: string
  readonly path: string
  readonly name?: string
  readonly version?: string
}

/** Scan `<dir>/.agents/<id>/AGENT.md`, returning one row per agent dir that
 *  carries a manifest (non-directory entries and dirs without an AGENT.md
 *  are skipped). Exported for the unit tests. */
export async function listAgentsFromDir(dir: string): Promise<DiscoveredAgent[]> {
  const agentsRoot = join(dir, ".agents")
  let entries: string[]
  try {
    entries = (await readdir(agentsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }

  const found: DiscoveredAgent[] = []
  for (const id of entries) {
    const path = join(agentsRoot, id, "AGENT.md")
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch {
      continue
    }
    let data: Record<string, unknown> = {}
    try {
      const parsed = matter(raw).data
      if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>
    } catch {
      // Unparseable frontmatter — still surfaced (id + path), no name/version.
    }
    const name = typeof data.name === "string" && data.name !== "" ? data.name : undefined
    const version = typeof data.version === "string" && data.version !== "" ? data.version : undefined
    found.push({
      id: typeof data.id === "string" && data.id !== "" ? data.id : id,
      path,
      ...(name !== undefined ? { name } : {}),
      ...(version !== undefined ? { version } : {}),
    })
  }
  return found
}

/** `agentproto agent list [dir]`. */
export async function runAgentList(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: { help: { type: "boolean", short: "h" } },
  })
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const dir = resolve(process.cwd(), expandHome(positionals[0] ?? "."))
  const agents = await listAgentsFromDir(dir)
  if (agents.length === 0) {
    process.stdout.write(`agentproto agent list: no agents under ${join(dir, ".agents")}\n`)
    return 0
  }
  for (const agent of agents) {
    const tail = [agent.name !== undefined ? `name: ${agent.name}` : undefined, agent.version !== undefined ? `v${agent.version}` : undefined]
      .filter((s): s is string => s !== undefined)
      .join("  ")
    process.stdout.write(`${agent.id} -> ${agent.path}${tail ? `  (${tail})` : ""}\n`)
  }
  return 0
}
