/**
 * `exposes.tools` (APP.md): the tools an app offers to MCP clients, each with
 * an explicit `access` class, and the one function that turns an entry into
 * its MCP name. Design contract: docs/design/exposes-tools-contract.md.
 *
 * Two layers, because the daemon/CLI names are not visible from this package:
 *   - `parseExposedTools` is structural (shape, prefix, names, collisions) and
 *     runs from `normalizeManifestFields` for both `defineApp` and
 *     `loadAppHandle`. The daemon-tool-name checks (reserved prefix, daemon
 *     ids) only run when the caller passes `daemonToolNames`.
 *   - `validateExposedToolsAgainstBundle` checks the entries against the app's
 *     own bundled TOOL.md contracts and `ui.tools`; `defineApp` runs it.
 *
 * The name rule lives ONLY in `exposedToolName`; the CLI and the daemon import
 * it rather than re-implementing it.
 */

import type { AppExposedTool, AppExposedToolAccess } from "./types.js"

export const EXPOSED_TOOL_ACCESS: readonly AppExposedToolAccess[] = ["read", "write", "approve"]
export const EXPOSED_TOOL_NAME_MAX = 64
export const EXPOSED_TOOL_DESCRIPTION_MAX = 300

const PREFIX_RE = /^[a-z][a-z0-9]{1,15}$/
const MCP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const ENTRY_KEYS = new Set(["id", "access", "description", "inputSchema", "mcpName", "approvalArg"])
const MUTATOR_TAGS = new Set(["mutator", "write"])

type Fail = (message: string) => Error

export interface ExposedToolReservedNames {
  /** The daemon's own tool names (`DAEMON_TOOL_NAMES`). When given, a prefix may
   *  not be the first `_` segment of one, and an id may not be one. */
  readonly daemonToolNames?: Iterable<string>
}

/** The slice of a bundled `ToolHandle` the validator needs. */
export interface ExposedToolBundledTool {
  readonly id: string
  readonly tags: readonly string[]
  readonly mutates: readonly string[]
  readonly inputs?: Record<string, unknown> | undefined
}

export interface ResolvedExposedTool {
  readonly entry: AppExposedTool
  /** The MCP-safe name, from {@link exposedToolName}. */
  readonly name: string
  /** `entry.inputSchema`, else the bundled TOOL.md `inputs`; undefined = none known. */
  readonly inputs: Record<string, unknown> | undefined
}

function stripPrefix(prefix: string, raw: string): string {
  for (const sep of [".", "_"]) {
    if (raw.startsWith(prefix + sep)) return raw.slice(prefix.length + 1)
  }
  return raw
}

/**
 * `<prefix>_<n>`: `n` is `mcpName` (else the entry id) without a leading
 * `<prefix>.`/`<prefix>_`, with every character outside `[a-zA-Z0-9_-]`
 * replaced by `_` and `_` runs merged. Throws on an `imported:` id without
 * `mcpName` (its `:` and `/` have no safe spelling to guess).
 */
export function exposedToolName(
  prefix: string,
  entry: { readonly id: string; readonly mcpName?: string | undefined },
): string {
  if (entry.mcpName === undefined && entry.id.startsWith("imported:")) {
    throw new Error(`tool '${entry.id}' needs an explicit mcpName: an imported id has no MCP-safe spelling.`)
  }
  const n = stripPrefix(prefix, entry.mcpName ?? entry.id)
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
  if (n === "") throw new Error(`tool '${entry.id}' yields an empty MCP name.`)
  return `${prefix}_${n}`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Structural validation of `exposes.prefix` + `exposes.tools`. */
export function parseExposedTools(
  rawTools: unknown,
  rawPrefix: unknown,
  fail: Fail,
  reserved: ExposedToolReservedNames = {},
): { prefix?: string; tools: AppExposedTool[] } {
  const daemonNames = new Set(reserved.daemonToolNames ?? [])

  let prefix: string | undefined
  if (rawPrefix !== undefined) {
    if (typeof rawPrefix !== "string" || !PREFIX_RE.test(rawPrefix)) {
      throw fail(`'exposes.prefix' must match ${PREFIX_RE} (lowercase, no '_'), got ${JSON.stringify(rawPrefix)}.`)
    }
    for (const name of daemonNames) {
      if (name.split("_")[0] === rawPrefix) {
        throw fail(`'exposes.prefix' '${rawPrefix}' is reserved: the daemon already has tools named '${rawPrefix}_*'.`)
      }
    }
    prefix = rawPrefix
  }

  if (rawTools === undefined) return { ...(prefix !== undefined ? { prefix } : {}), tools: [] }
  if (!Array.isArray(rawTools)) throw fail("'exposes.tools' must be an array of { id, access, description, ... }.")
  if (rawTools.length > 0 && prefix === undefined) {
    throw fail("'exposes.prefix' is required when 'exposes.tools' is non-empty.")
  }

  const tools: AppExposedTool[] = []
  const ids = new Set<string>()
  const names = new Map<string, string>()
  rawTools.forEach((raw, i) => {
    const at = `exposes.tools[${i}]`
    if (!isRecord(raw)) throw fail(`'${at}' must be an object.`)
    for (const key of Object.keys(raw)) {
      if (!ENTRY_KEYS.has(key)) {
        throw fail(`'${at}' has unknown key '${key}'. Allowed: ${[...ENTRY_KEYS].join(", ")}.`)
      }
    }
    const { id, access, description, inputSchema, mcpName, approvalArg } = raw
    if (typeof id !== "string" || id === "") throw fail(`'${at}.id' must be a non-empty string.`)
    if (!EXPOSED_TOOL_ACCESS.includes(access as AppExposedToolAccess)) {
      throw fail(`'${at}' ('${id}'): 'access' must be one of ${EXPOSED_TOOL_ACCESS.join(" | ")}.`)
    }
    if (typeof description !== "string" || description.trim() === "") {
      throw fail(`'${at}' ('${id}'): 'description' is required (written for a model).`)
    }
    if (description.length > EXPOSED_TOOL_DESCRIPTION_MAX) {
      throw fail(`'${at}' ('${id}'): 'description' is ${description.length} chars, max ${EXPOSED_TOOL_DESCRIPTION_MAX}.`)
    }
    if (inputSchema !== undefined && !isRecord(inputSchema)) {
      throw fail(`'${at}' ('${id}'): 'inputSchema' must be a JSON Schema object.`)
    }
    if (mcpName !== undefined && (typeof mcpName !== "string" || !MCP_NAME_RE.test(mcpName))) {
      throw fail(`'${at}' ('${id}'): 'mcpName' must match ${MCP_NAME_RE} (no ':', '/', '.').`)
    }
    if (approvalArg !== undefined) {
      if (access !== "approve") throw fail(`'${at}' ('${id}'): 'approvalArg' only applies to access: approve.`)
      if (typeof approvalArg !== "string" || approvalArg === "") {
        throw fail(`'${at}' ('${id}'): 'approvalArg' must be a non-empty string.`)
      }
    }
    if (/^approval/.test(id) || (typeof mcpName === "string" && /^approval/.test(mcpName))) {
      throw fail(
        `'${at}' ('${id}'): an id or mcpName starting with 'approval' is refused: deciding an approval never goes through this registry.`,
      )
    }
    if (daemonNames.has(id)) {
      throw fail(`'${at}': '${id}' is a daemon tool; it stays reserved to the UI through 'ui.tools'.`)
    }
    if (id.startsWith("imported:")) {
      if (mcpName === undefined) throw fail(`'${at}' ('${id}'): an imported id needs an explicit 'mcpName'.`)
      if (access !== "read") throw fail(`'${at}' ('${id}'): an imported id can only be exposed as access: read.`)
    }
    if (ids.has(id)) throw fail(`'${at}': duplicate id '${id}'.`)
    ids.add(id)

    let name: string
    try {
      name = exposedToolName(prefix!, { id, mcpName: mcpName as string | undefined })
    } catch (err) {
      throw fail(`'${at}': ${err instanceof Error ? err.message : String(err)}`)
    }
    if (name.length > EXPOSED_TOOL_NAME_MAX) {
      throw fail(`'${at}' ('${id}'): MCP name '${name}' is ${name.length} chars, max ${EXPOSED_TOOL_NAME_MAX}.`)
    }
    const clash = names.get(name)
    if (clash !== undefined) {
      throw fail(`'${at}': '${id}' and '${clash}' compute the same MCP name '${name}'; set 'mcpName' on one.`)
    }
    names.set(name, id)

    tools.push({
      id,
      access: access as AppExposedToolAccess,
      description,
      ...(inputSchema !== undefined ? { inputSchema } : {}),
      ...(mcpName !== undefined ? { mcpName } : {}),
      ...(approvalArg !== undefined ? { approvalArg } : {}),
    })
  })
  return { prefix: prefix!, tools }
}

/**
 * Check the entries against the app's own bundled TOOL.md contracts: a non-
 * `imported:` id must resolve to one, and `access: read` is refused on a tool
 * that declares `mutates` or a `mutator`/`write` tag.
 *
 * Temporary (lifted when the daemon dispatches `exposes.tools` itself): every
 * id must also be in `ui.tools`, because `POST /apps/:appId/tool-call` only
 * accepts that allowlist.
 */
export function validateExposedToolsAgainstBundle(
  exposes: { readonly tools?: readonly AppExposedTool[] },
  ctx: { readonly tools: readonly ExposedToolBundledTool[]; readonly uiTools?: readonly string[] | undefined },
  fail: Fail,
): void {
  for (const entry of exposes.tools ?? []) {
    if (!(ctx.uiTools ?? []).includes(entry.id)) {
      throw fail(`'exposes.tools' names '${entry.id}' which is not in 'ui.tools'; the tool-call route only accepts 'ui.tools' ids.`)
    }
    if (entry.id.startsWith("imported:")) continue
    const tool = ctx.tools.find(t => t.id === entry.id)
    if (!tool) {
      throw fail(`'exposes.tools' names '${entry.id}' but the app bundles no such TOOL.md (.agentproto/tools/${entry.id}/TOOL.md).`)
    }
    if (entry.access !== "read") continue
    const tag = tool.tags.find(t => MUTATOR_TAGS.has(t.toLowerCase()))
    if (tool.mutates.length > 0 || tag !== undefined) {
      throw fail(
        `'exposes.tools' lists '${entry.id}' as access: read but its TOOL.md ${
          tool.mutates.length > 0 ? `declares mutates [${tool.mutates.join(", ")}]` : `is tagged '${tag}'`
        }; use access: write or approve.`,
      )
    }
  }
}

/** Entries with their computed MCP name and real input schema, in declared order. */
export function resolveExposedTools(
  exposes: { readonly prefix?: string | undefined; readonly tools?: readonly AppExposedTool[] },
  bundled: readonly ExposedToolBundledTool[],
): ResolvedExposedTool[] {
  if (exposes.prefix === undefined) return []
  const prefix = exposes.prefix
  return (exposes.tools ?? []).map(entry => ({
    entry,
    name: exposedToolName(prefix, entry),
    inputs: entry.inputSchema ?? bundled.find(t => t.id === entry.id)?.inputs,
  }))
}
