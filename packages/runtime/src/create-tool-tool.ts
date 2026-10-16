/**
 * `create_tool` / `delete_tool` — daemon MCP verbs that author an AIP-14
 * TOOL.md (+ AIP-30 DRIVER.md) doctype pair into the workspace's app bundle
 * layout (`.agentproto/tools/<id>/TOOL.md`, `.agentproto/drivers/<id>/DRIVER.md`)
 * — the same layout apps ship and `app-mcp-server` loads.
 *
 * This is a NEW primitive (there was no `create_tool` before): the doctype
 * *loading* path existed, the *authoring* verb did not. It is registered like
 * any other runtime tool, but GATED by the caller's AIP-42 manifest
 * `actions.granted`: an agent must explicitly list `create_tool` (AIP-42
 * `AGENT.schema.json` "actions.granted", `AGENT.schema.json:57-68`) in its own
 * manifest. Default-granted to NOBODY — an operator/root call with no manifest
 * is refused. The manifest is parsed by `@agentproto/agent` (gray-matter, real
 * YAML), so both the inline-array `[ "create_tool" ]` and a block list parse
 * natively; no flat-parser upgrade is needed on this side.
 *
 * Scoping — honest: the loader is app/workspace-scoped, so a created tool is
 * immediately callable by any session of that app/workspace. Per-owner private
 * tools are a documented NON-GOAL (they need a loader seam change).
 *
 * Churn/lifetime guards (PLAN §3.3):
 *  - `minLifetimeMs` (default 1h): a created TOOL.md can be neither overwritten
 *    (`create_tool force:true`) nor deleted before it expires.
 *  - `deleteLimit`: at most N tombstones per agent/day (default 5) — the
 *    per-day delete-limit that stops create/delete thrash.
 *  - a lock file beside the tools dir serializes authoring (one create/delete
 *    at a time).
 *  - every created tool defaults `approval: "always"` until a human flips it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { existsSync } from "node:fs"
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { loadAgent } from "@agentproto/agent"

/** AIP-14 id regex — the same one `parseToolManifest` enforces. */
export const TOOL_ID_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/

/** A created TOOL.md cannot be overwritten/deleted before this has elapsed. */
export const DEFAULT_MIN_LIFETIME_MS = 60 * 60 * 1000

/** Max tombstones (deletes) per agent per calendar day. */
export const DEFAULT_DELETE_LIMIT = 5

/** A created tool's default approval class until a human flips it. */
export const DEFAULT_CREATED_TOOL_APPROVAL = "always"

export interface CreateToolDriver {
  readonly kind: "cli" | "http"
  /** `kind: cli`. */
  readonly bin?: string
  readonly argv?: readonly string[]
  /** `kind: http`. */
  readonly baseUrl?: string
  readonly method?: string
  readonly path?: string
}

export interface CreateToolInput {
  readonly workspace: string
  readonly id: string
  readonly description: string
  /** The calling agent's logical AIP-42 id — the grant is read from it. */
  readonly agentId: string
  readonly driver: CreateToolDriver
  readonly name?: string
  readonly version?: string
  readonly inputs?: Record<string, unknown>
  readonly outputs?: Record<string, unknown>
  readonly approval?: string
  /** Overwrite an existing TOOL.md (still bounded by `minLifetimeMs`). */
  readonly force?: boolean
  /** Tests: clock + guard overrides. */
  readonly now?: () => number
  readonly minLifetimeMs?: number
}

export interface CreatedTool {
  readonly id: string
  readonly toolPath: string
  readonly driverPath: string
}

const GRANT_VERB = "create_tool"
const DELETE_GRANT_VERB = "create_tool"

function grantNames(granted: readonly unknown[] | undefined): string[] {
  const names: string[] = []
  for (const entry of granted ?? []) {
    if (typeof entry === "string") names.push(entry)
    else if (entry && typeof entry === "object") {
      const action = (entry as { action?: unknown }).action
      if (typeof action === "string") names.push(action)
    }
  }
  return names
}

/**
 * True when the agent manifest at `<workspace>/.agents/<id>/AGENT.md` (or the
 * app-emitted `.agentproto/agents/` location) grants `create_tool`. Throws a
 * user-facing error when the manifest is missing — default is DENY, never a
 * silent allow.
 */
export async function assertActionGranted(
  agentId: string,
  verb: string,
  workspace: string,
): Promise<void> {
  const candidates = [
    join(workspace, ".agents", agentId, "AGENT.md"),
    join(workspace, ".agentproto", "agents", agentId, "AGENT.md"),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const { handle } = await loadAgent(candidate)
    const granted = grantNames(handle.actions?.granted)
    if (granted.includes(verb)) return
    throw new Error(
      `${verb}: agent '${agentId}' does not grant '${verb}' — add it to the manifest's ` +
        `\`actions.granted\` list (default-granted to nobody).`,
    )
  }
  throw new Error(
    `${verb}: no AGENT.md found for agent '${agentId}' at any of: ${candidates.join(", ")}. ` +
      `Default is DENY — an agent must exist and grant '${verb}'.`,
  )
}

function toolPath(workspace: string, id: string): string {
  return join(workspace, ".agentproto", "tools", id, "TOOL.md")
}

function driverPath(workspace: string, id: string): string {
  return join(workspace, ".agentproto", "drivers", id, "DRIVER.md")
}

function lockPath(workspace: string): string {
  return join(workspace, ".agentproto", "tools", ".authoring.lock")
}

function tombstonesPath(workspace: string): string {
  return join(workspace, ".agentproto", "tools", ".tombstones.json")
}

/** Serialize authoring behind an exclusive lock file beside the tools dir. */
async function withAuthoringLock<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const path = lockPath(workspace)
  await mkdir(dirname(path), { recursive: true })
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, "wx")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "create_tool: another tool-authoring call is in progress (.agentproto/tools/.authoring.lock exists).",
      )
    }
    throw err
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    return await fn()
  } finally {
    await handle.close().catch(() => {})
    await rm(path, { force: true }).catch(() => {})
  }
}

function renderTool(manifest: {
  id: string
  name: string
  description: string
  version: string
  approval: string
  inputs?: Record<string, unknown>
  outputs?: Record<string, unknown>
}): string {
  const lines: string[] = [
    "---",
    "schema: agentproto/tool/v1",
    `id: ${manifest.id}`,
    `name: ${JSON.stringify(manifest.name)}`,
    "description: >-",
    ...manifest.description.split("\n").map(l => `  ${l}`),
    `version: ${manifest.version}`,
    `approval: ${manifest.approval}`,
  ]
  if (manifest.inputs) lines.push("inputs:", indentYaml(manifest.inputs))
  if (manifest.outputs) lines.push("outputs:", indentYaml(manifest.outputs))
  lines.push("---", "", `# ${manifest.name}`, "", manifest.description, "")
  return lines.join("\n")
}

function renderDriver(
  id: string,
  name: string,
  driver: CreateToolDriver,
  version: string,
): string {
  if (driver.kind === "cli") {
    const bin = driver.bin?.trim()
    if (!bin) throw new Error("create_tool: a kind:cli driver requires a non-empty `bin`.")
    if (!driver.argv || driver.argv.length === 0) {
      throw new Error("create_tool: a kind:cli driver requires a non-empty `argv` array.")
    }
    const argv = driver.argv.map(a => `          - ${JSON.stringify(a)}`).join("\n")
    return [
      "---",
      "schema: agentproto/driver/v1",
      `id: ${id}`,
      `name: ${JSON.stringify(`${name} — CLI Driver`)}`,
      "description: >-",
      `  CLI implementation of the ${id} tool contract.`,
      `version: ${version}`,
      "kind: cli",
      "implements:",
      `  - tool: ${id}`,
      `    version: "^${version}"`,
      "    metadata:",
      "      cli:",
      "        argv:",
      argv,
      "        outputFormat: json",
      "metadata:",
      "  cli:",
      `    bin: ${JSON.stringify(bin)}`,
      "---",
      "",
      `# ${name} — CLI Driver`,
      "",
      `Runs \`${bin} ${driver.argv.join(" ")}\` from the app root.`,
      "",
    ].join("\n")
  }
  const baseUrl = driver.baseUrl?.trim()
  if (!baseUrl) throw new Error("create_tool: a kind:http driver requires a non-empty `baseUrl`.")
  return [
    "---",
    "schema: agentproto/driver/v1",
    `id: ${id}`,
    `name: ${JSON.stringify(`${name} — HTTP Driver`)}`,
    "description: >-",
    `  HTTP implementation of the ${id} tool contract.`,
    `version: ${version}`,
    "kind: http",
    "implements:",
    `  - tool: ${id}`,
    `    version: "^${version}"`,
    "metadata:",
    "  http:",
    `    baseUrl: ${JSON.stringify(baseUrl)}`,
    ...(driver.method ? [`    defaultMethod: ${driver.method.toUpperCase()}`] : []),
    ...(driver.path ? [`    path: ${JSON.stringify(driver.path)}`] : []),
    "---",
    "",
    `# ${name} — HTTP Driver`,
    "",
    `Dispatches to \`${baseUrl}\`.`,
    "",
  ].join("\n")
}

/** Indent a plain object's JSON as YAML-ish nested mapping (2 spaces). */
function indentYaml(value: Record<string, unknown>, depth = 1): string {
  const pad = "  ".repeat(depth)
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? `${pad}${line}` : `${pad}${line}`))
    .join("\n")
}

async function assertMinLifetime(
  path: string,
  minLifetimeMs: number,
  now: () => number,
  verb: string,
): Promise<void> {
  if (minLifetimeMs <= 0) return
  if (!existsSync(path)) return
  const info = await stat(path)
  const ageMs = now() - info.mtimeMs
  if (ageMs < minLifetimeMs) {
    const mins = Math.ceil((minLifetimeMs - ageMs) / 60_000)
    throw new Error(
      `${verb}: '${path}' was created ${Math.round(ageMs / 1000)}s ago — it cannot be changed before ` +
        `its ${Math.round(minLifetimeMs / 60_000)}-minute minimum lifetime elapses (~${mins} min left).`,
    )
  }
}

/**
 * Core authoring logic, extracted for testability. Throws a user-facing
 * `Error` on a denied grant, a bad id, an existing tool without `force`, an
 * overwrite inside `minLifetimeMs`, or a malformed driver.
 */
export async function createToolManifest(input: CreateToolInput): Promise<CreatedTool> {
  if (!TOOL_ID_PATTERN.test(input.id)) {
    throw new Error(
      `create_tool: invalid id '${input.id}' — must match ${TOOL_ID_PATTERN} (lowercase letter, then letters/digits/._-).`,
    )
  }
  await assertActionGranted(input.agentId, GRANT_VERB, input.workspace)

  const now = input.now ?? Date.now
  const minLifetimeMs = input.minLifetimeMs ?? DEFAULT_MIN_LIFETIME_MS
  const version = input.version ?? "1.0.0"
  const name = input.name?.trim() || input.id
  const approval = input.approval ?? DEFAULT_CREATED_TOOL_APPROVAL

  const toolFile = toolPath(input.workspace, input.id)
  const driverFile = driverPath(input.workspace, input.id)
  const contents = renderTool({
    id: input.id,
    name,
    description: input.description,
    version,
    approval,
    ...(input.inputs ? { inputs: input.inputs } : {}),
    ...(input.outputs ? { outputs: input.outputs } : {}),
  })
  const driverContents = renderDriver(input.id, name, input.driver, version)

  return withAuthoringLock(input.workspace, async () => {
    if (existsSync(toolFile)) {
      if (input.force !== true) {
        throw new Error(`create_tool: '${toolFile}' already exists (pass force: true to overwrite).`)
      }
      await assertMinLifetime(toolFile, minLifetimeMs, now, "create_tool")
    }
    await mkdir(dirname(toolFile), { recursive: true })
    await mkdir(dirname(driverFile), { recursive: true })
    await writeFile(toolFile, contents, "utf8")
    await writeFile(driverFile, driverContents, "utf8")
    return { id: input.id, toolPath: toolFile, driverPath: driverFile }
  })
}

export interface DeleteToolInput {
  readonly workspace: string
  readonly id: string
  readonly agentId: string
  readonly now?: () => number
  readonly minLifetimeMs?: number
  readonly deleteLimit?: number
}

interface TombstoneState {
  [agentId: string]: { day: string; count: number }
}

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

async function readTombstones(path: string): Promise<TombstoneState> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as TombstoneState
  } catch {
    return {}
  }
}

/**
 * Delete a created tool's TOOL.md + DRIVER.md, bounded by `minLifetimeMs` and a
 * per-agent/day `deleteLimit` (tombstones). Same grant as `create_tool`.
 */
export async function deleteToolManifest(input: DeleteToolInput): Promise<{ id: string; deleted: string[] }> {
  if (!TOOL_ID_PATTERN.test(input.id)) {
    throw new Error(`delete_tool: invalid id '${input.id}'.`)
  }
  await assertActionGranted(input.agentId, DELETE_GRANT_VERB, input.workspace)

  const now = input.now ?? Date.now
  const minLifetimeMs = input.minLifetimeMs ?? DEFAULT_MIN_LIFETIME_MS
  const deleteLimit = input.deleteLimit ?? DEFAULT_DELETE_LIMIT
  const toolFile = toolPath(input.workspace, input.id)
  const driverFile = driverPath(input.workspace, input.id)

  return withAuthoringLock(input.workspace, async () => {
    if (!existsSync(toolFile)) throw new Error(`delete_tool: '${toolFile}' does not exist.`)
    await assertMinLifetime(toolFile, minLifetimeMs, now, "delete_tool")

    const at = now()
    const ledger = tombstonesPath(input.workspace)
    const state = await readTombstones(ledger)
    const today = dayKey(at)
    const entry = state[input.agentId]
    const count = entry && entry.day === today ? entry.count : 0
    if (count >= deleteLimit) {
      throw new Error(
        `delete_tool: agent '${input.agentId}' has reached its ${deleteLimit}-deletion/day limit — refusing to thrash.`,
      )
    }

    const deleted: string[] = []
    for (const path of [toolFile, driverFile]) {
      if (existsSync(path)) {
        await rm(path, { force: true })
        deleted.push(path)
      }
    }
    state[input.agentId] = { day: today, count: count + 1 }
    await mkdir(dirname(ledger), { recursive: true })
    await writeFile(ledger, JSON.stringify(state, null, 2) + "\n", "utf8")
    return { id: input.id, deleted }
  })
}

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }
}

function fail(err: unknown) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) },
    ],
  }
}

/** Register `create_tool` + `delete_tool`. The workspace is injected at
 *  registration time; the caller supplies only the logical id + its own
 *  `agentId` (the grant subject). */
export function registerCreateToolTools(server: McpServer, opts: { workspace: string }): void {
  server.tool(
    "create_tool",
    "Author an AIP-14/AIP-30 tool pair (`.agentproto/tools/<id>/TOOL.md` + " +
      "`.agentproto/drivers/<id>/DRIVER.md`) in this workspace. GATED by the caller's " +
      "AIP-42 manifest `actions.granted` (default-denied: pass the granting agent's `agentId`). " +
      "A tool cannot be overwritten before its minimum lifetime; use `delete_tool` to remove one " +
      "(bounded by a per-day delete limit). Created tools default to approval:\"always\".",
    {
      id: z.string().describe("AIP-14 tool id (regex ^[a-z][a-z0-9._-]{1,63}$)."),
      description: z.string().min(1).describe("One-paragraph purpose."),
      agentId: z.string().min(1).describe("The calling agent's AIP-42 logical id (grant subject)."),
      driver: z
        .object({
          kind: z.enum(["cli", "http"]),
          bin: z.string().optional().describe("kind:cli binary (e.g. \"node\")."),
          argv: z.array(z.string()).optional().describe("kind:cli argv (script + templated args)."),
          baseUrl: z.string().optional().describe("kind:http base URL."),
          method: z.string().optional().describe("kind:http default method."),
          path: z.string().optional().describe("kind:http path."),
        })
        .describe("Dispatch declaration — kind:cli (bin+argv) or kind:http (baseUrl)."),
      name: z.string().optional(),
      version: z.string().optional().describe("Semver, defaults to 1.0.0."),
      inputs: z.record(z.string(), z.unknown()).optional().describe("AIP-16 JSON Schema inputs block."),
      outputs: z.record(z.string(), z.unknown()).optional().describe("AIP-16 JSON Schema outputs block."),
      approval: z.string().optional().describe("ApprovalClass, defaults to \"always\"."),
      force: z.boolean().optional().describe("Overwrite an existing tool (still bounded by minLifetime)."),
    },
    async input => {
      try {
        const created = await createToolManifest({
          workspace: opts.workspace,
          id: input.id,
          description: input.description,
          agentId: input.agentId,
          driver: input.driver,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.version !== undefined ? { version: input.version } : {}),
          ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
          ...(input.outputs !== undefined ? { outputs: input.outputs } : {}),
          ...(input.approval !== undefined ? { approval: input.approval } : {}),
          ...(input.force !== undefined ? { force: input.force } : {}),
        })
        return ok(created)
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.tool(
    "delete_tool",
    "Remove a created AIP-14/AIP-30 tool pair, bounded by its minimum lifetime and a " +
      "per-agent/day delete limit. Same `actions.granted` gate as `create_tool`.",
    {
      id: z.string().describe("AIP-14 tool id to remove."),
      agentId: z.string().min(1).describe("The calling agent's AIP-42 logical id (grant subject)."),
    },
    async input => {
      try {
        const result = await deleteToolManifest({
          workspace: opts.workspace,
          id: input.id,
          agentId: input.agentId,
        })
        return ok(result)
      } catch (err) {
        return fail(err)
      }
    },
  )
}
