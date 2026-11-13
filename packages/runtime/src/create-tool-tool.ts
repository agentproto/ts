/**
 * `create_tool` / `delete_tool` — daemon MCP verbs that author an AIP-14
 * TOOL.md (+ AIP-30 DRIVER.md) doctype pair into the workspace's app bundle
 * layout (`.agentproto/tools/<id>/TOOL.md`, `.agentproto/drivers/<id>/DRIVER.md`)
 * — the same layout apps ship and `app-mcp-server` loads.
 *
 * This is a NEW primitive (there was no `create_tool` before): the doctype
 * *loading* path existed, the *authoring* verb did not. It is registered like
 * any other runtime tool, but GATED by the authenticated CALLER'S AIP-42
 * manifest `actions.granted`: the identity is resolved by the daemon from the
 * request's trusted `callerSessionId` (the session's own manifest, recorded at
 * spawn in `session-spawn.ts`), NEVER from a caller-supplied tool argument.
 * Default-granted to NOBODY — an operator/root call with no manifest, or a
 * call whose session carries no resolvable manifest, is refused (fail closed).
 * The manifest is parsed by `@agentproto/agent` (gray-matter, real YAML), so
 * both the inline-array `[ "create_tool" ]` and a block list parse natively.
 *
 * Calling a created tool: `created_tool_call` (registered here, next to
 * `create_tool`) runs a tool this verb authored in the daemon workspace. It is
 * a fixed verb, so it is already in the tool list a session got when it
 * connected: the session that created the tool can call it right away, with
 * no respawn (the created tool does not appear as its own MCP tool). EVERY
 * call needs a human-approved, single-use approval (`approval_request` kind
 * `created_tool_call`, payload `{ tool, args, toolSha256 }`, the exact request
 * returned by a call made without one) requested by the calling session, whatever `approval` class the TOOL.md declares: the class is
 * written by the agent that created the tool, so it cannot relax the gate.
 * Only tools that carry the authoring marker run here; a hand-written or
 * app-bundled TOOL.md never does. Any session on the gateway may ask, the same
 * reach every gateway verb has; the human decision is the gate.
 *
 * Per-owner private tools are a documented NON-GOAL (they need a loader seam
 * change).
 *
 * Churn/lifetime guards (PLAN §3.3):
 *  - `minLifetimeMs` (default 1h): a created TOOL.md can be neither overwritten
 *    (`create_tool force:true`) nor deleted before it expires.
 *  - an authoring MARKER (`.agentproto/tools/<id>/.authoring.json`, written on
 *    first authoring) distinguishes tools this mechanism created from
 *    operator/`emitApp`-authored ones; `force:true` may ONLY overwrite a tool
 *    that carries the marker. A foreign/manual TOOL.md is refused outright.
 *  - `deleteLimit`: at most N tombstones per agent/day (default 5) — the
 *    per-day delete-limit that stops create/delete thrash.
 *  - a lock file beside the tools dir serializes authoring (one create/delete
 *    at a time); a dead-pid or past-TTL lock is reclaimed rather than DoSing
 *    authoring forever after a crash.
 *  - every created tool defaults `approval: "always"` until a human flips it.
 *
 * Rendering: the TOOL.md is produced by the canonical `@agentproto/tool`
 * `createTool` renderer (validates via `defineTool`, serializes with
 * gray-matter); the DRIVER.md frontmatter is serialized with gray-matter too,
 * so both stay byte-compatible with `parseToolManifest` / `parseDriverManifest`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createHash } from "node:crypto"
import { constants as fsConstants, createReadStream, existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, posix, relative } from "node:path"
import matter from "gray-matter"
import { z } from "zod"
import { AGENT_ID_PATTERN, loadAgent } from "@agentproto/agent"
import { loadBundledTool, stripOwner, type LoadedBundledTool } from "@agentproto/app"
import { createTool, type ToolContext, type ToolDefinition } from "@agentproto/tool"
import { runTool } from "@agentproto/driver"
import type { ApprovalsEngine } from "./approvals/engine.js"
import type { ApprovalRequester } from "./approvals/types.js"

/** AIP-14 id regex — the same one `parseToolManifest` enforces. */
export const TOOL_ID_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/

/** A created TOOL.md cannot be overwritten/deleted before this has elapsed. */
export const DEFAULT_MIN_LIFETIME_MS = 60 * 60 * 1000

/** Max tombstones (deletes) per agent per calendar day. */
export const DEFAULT_DELETE_LIMIT = 5

/** A created tool's default approval class until a human flips it. */
export const DEFAULT_CREATED_TOOL_APPROVAL = "always"

/**
 * An authoring lock whose recorded `pid` is dead, OR whose `at` is older than
 * this, is considered abandoned (a crashed process left it) and is reclaimed
 * instead of DoSing every later `create_tool`/`delete_tool` forever.
 */
export const AUTHORING_LOCK_TTL_MS = 10 * 60 * 1000

/** Marker filename written beside an authored tool (`.agentproto/tools/<id>/`). */
export const AUTHORING_MARKER_FILE = ".authoring.json"

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

/**
 * The authenticated caller's AIP-42 identity. Resolved by the gateway from the
 * trusted `callerSessionId` and injected at registration time — never taken
 * from the tool's payload. `manifestPath` (the exact AGENT.md the session was
 * spawned from) wins over `agentId` when present.
 */
export interface CallerIdentity {
  /** Logical AIP-42 id of the caller's manifest (owner prefix allowed). */
  readonly agentId?: string
  /** Absolute path of the caller's AGENT.md, if the daemon resolved one. */
  readonly manifestPath?: string
  /** The trusted caller session id — used only to name the caller in errors. */
  readonly sessionId?: string
}

/** The trusted identity fields the gateway injects onto an authoring call.
 *  Named `caller*` to make explicit they are NEVER read from the tool
 *  payload. */
export interface CallerIdentityInput {
  readonly callerAgentId?: string
  readonly callerAgentManifestPath?: string
  readonly callerSessionId?: string
}

function callerOf(input: CallerIdentityInput): CallerIdentity {
  return {
    ...(input.callerAgentId !== undefined ? { agentId: input.callerAgentId } : {}),
    ...(input.callerAgentManifestPath !== undefined ? { manifestPath: input.callerAgentManifestPath } : {}),
    ...(input.callerSessionId !== undefined ? { sessionId: input.callerSessionId } : {}),
  }
}

export interface CreateToolInput extends CallerIdentityInput {
  readonly workspace: string
  readonly id: string
  readonly description: string
  readonly driver: CreateToolDriver
  readonly name?: string
  readonly version?: string
  readonly inputs?: Record<string, unknown>
  readonly outputs?: Record<string, unknown>
  readonly approval?: string
  /** Overwrite an existing authored TOOL.md (still bounded by the marker + minLifetime). */
  readonly force?: boolean
  /** Tests: clock + guard overrides. */
  readonly now?: () => number
  readonly minLifetimeMs?: number
  readonly authoringLockTtlMs?: number
}

export interface CreatedTool {
  readonly id: string
  readonly toolPath: string
  readonly driverPath: string
}

const GRANT_VERB = "create_tool"

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

function deniedByGrant(verb: string, id: string): Error {
  return new Error(
    `${verb}: agent '${id}' does not grant '${verb}' — add it to the manifest's ` +
      `\`actions.granted\` list (default-granted to nobody).`,
  )
}

/**
 * Resolve the authenticated caller's AIP-42 manifest and assert it grants
 * `verb`. Returns the caller's logical agent id (owner prefix stripped) — the
 * trusted subject for the delete ledger and the authoring marker.
 *
 * Fails CLOSED: no caller identity at all (an operator/root call, an app
 * session with no manifest, an internal call) is refused rather than silently
 * allowed. The `callerSessionId` is named in the error so the operator can see
 * which session was refused. Never reads a caller-supplied `agentId`.
 */
export async function assertActionGranted(
  caller: CallerIdentity,
  verb: string,
  workspace: string,
): Promise<string> {
  if (caller.manifestPath !== undefined && caller.manifestPath.trim() !== "") {
    const path = caller.manifestPath
    if (!existsSync(path)) {
      throw new Error(
        `${verb}: caller manifest '${path}' (session '${caller.sessionId ?? "<unknown>"}') not found. ` +
          `Default is DENY — an agent must exist and grant '${verb}'.`,
      )
    }
    const { handle } = await loadAgent(path)
    if (!grantNames(handle.actions?.granted).includes(verb)) {
      throw deniedByGrant(verb, stripOwner(handle.id))
    }
    return stripOwner(handle.id)
  }

  if (caller.agentId !== undefined && caller.agentId.trim() !== "") {
    const raw = caller.agentId.trim()
    // AIP-42 id regex — reject path traversal / separators BEFORE any join.
    if (!AGENT_ID_PATTERN.test(raw)) {
      throw new Error(
        `${verb}: invalid caller agent id '${raw}' — refusing to resolve it to a path ` +
          `(must match ${AGENT_ID_PATTERN}).`,
      )
    }
    const id = stripOwner(raw)
    const candidates = [
      join(workspace, ".agents", id, "AGENT.md"),
      join(workspace, ".agentproto", "agents", id, "AGENT.md"),
    ]
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      const { handle } = await loadAgent(candidate)
      if (!grantNames(handle.actions?.granted).includes(verb)) {
        throw deniedByGrant(verb, id)
      }
      return stripOwner(handle.id)
    }
    throw new Error(
      `${verb}: no AGENT.md found for caller agent '${id}' at any of: ${candidates.join(", ")}. ` +
        `Default is DENY — an agent must exist and grant '${verb}'.`,
    )
  }

  throw new Error(
    `${verb}: no authenticated caller identity — refusing (default DENY). Caller session ` +
      `'${caller.sessionId ?? "<none>"}' carries no resolvable AIP-42 manifest granting '${verb}'. ` +
      `Spawn the caller with a manifest (agentId/agentPath) that lists '${verb}' in \`actions.granted\`.`,
  )
}

function toolPath(workspace: string, id: string): string {
  return join(workspace, ".agentproto", "tools", id, "TOOL.md")
}

function driverPath(workspace: string, id: string): string {
  return join(workspace, ".agentproto", "drivers", id, "DRIVER.md")
}

function authoringMarkerPath(workspace: string, id: string): string {
  return join(workspace, ".agentproto", "tools", id, AUTHORING_MARKER_FILE)
}

function lockPath(workspace: string): string {
  return join(workspace, ".agentproto", "tools", ".authoring.lock")
}

function tombstonesPath(workspace: string): string {
  return join(workspace, ".agentproto", "tools", ".tombstones.json")
}

interface AuthoringMarker {
  readonly createdAt: string
  readonly creatorAgent: string
  readonly by: "create_tool"
}

async function readAuthoringMarker(path: string): Promise<AuthoringMarker | undefined> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AuthoringMarker>
    if (parsed.by !== "create_tool") return undefined
    return {
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      creatorAgent: typeof parsed.creatorAgent === "string" ? parsed.creatorAgent : "",
      by: "create_tool",
    }
  } catch {
    return undefined
  }
}

/** True when the recorded pid is gone (ESRCH) or unkillable for any reason. */
function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 performs error checking without sending a signal.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * True when the lock at `path` is abandoned: its recorded pid is dead, or its
 * timestamp is older than the TTL. An unparseable lock falls back to the file's
 * mtime, so a partially-written lock is only reclaimed once it is also old.
 */
async function isStaleLock(path: string, ttlMs: number, now: () => number): Promise<boolean> {
  let raw: string | undefined
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return false
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; at?: unknown }
    if (typeof parsed.at === "string") {
      const at = Date.parse(parsed.at)
      if (Number.isFinite(at) && now() - at > ttlMs) return true
    }
    if (typeof parsed.pid === "number" && parsed.pid > 0 && !isPidAlive(parsed.pid)) return true
    return false
  } catch {
    try {
      const info = await stat(path)
      return now() - info.mtimeMs > ttlMs
    } catch {
      return true
    }
  }
}

/**
 * Serialize authoring behind an exclusive lock file beside the tools dir. A
 * lock left behind by a crashed process (dead pid) or held past the TTL is
 * reclaimed; a live, fresh lock still makes the caller throw immediately.
 */
async function withAuthoringLock<T>(
  workspace: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; now?: () => number } = {},
): Promise<T> {
  const path = lockPath(workspace)
  const ttlMs = opts.ttlMs ?? AUTHORING_LOCK_TTL_MS
  const now = opts.now ?? Date.now
  const inProgress = (): Error =>
    new Error(
      "create_tool: another tool-authoring call is in progress (.agentproto/tools/.authoring.lock exists).",
    )
  await mkdir(dirname(path), { recursive: true })
  const acquire = () => open(path, "wx")
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await acquire()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    if (!(await isStaleLock(path, ttlMs, now))) throw inProgress()
    // Reclaim: remove the abandoned lock and retry once. Another racer may
    // grab it first — then this is a genuine live contention, so throw.
    await rm(path, { force: true })
    try {
      handle = await acquire()
    } catch (retryErr) {
      if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") throw inProgress()
      throw retryErr
    }
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }),
    )
    return await fn()
  } finally {
    await handle.close().catch(() => {})
    await rm(path, { force: true }).catch(() => {})
  }
}

interface RenderToolInput {
  id: string
  name: string
  description: string
  version: string
  approval: string
  workspace: string
  inputs?: Record<string, unknown>
  outputs?: Record<string, unknown>
}

/**
 * Render the TOOL.md via the canonical `@agentproto/tool` `createTool`
 * renderer (validates with `defineTool`, serializes with gray-matter) in
 * dry-run mode, so the bytes round-trip through `parseToolManifest`.
 */
async function renderTool(manifest: RenderToolInput): Promise<string> {
  const definition = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    approval: manifest.approval,
    ...(manifest.inputs ? { inputs: manifest.inputs } : {}),
    ...(manifest.outputs ? { outputs: manifest.outputs } : {}),
  } as unknown as ToolDefinition<unknown, unknown, ToolContext>
  const { rendered } = await createTool<unknown, unknown, ToolContext>(definition, {
    dir: join(manifest.workspace, ".agentproto", "tools"),
    body: `# ${manifest.name}\n\n${manifest.description}\n`,
    dryRun: true,
  })
  return rendered
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
    const body = `# ${name} — CLI Driver\n\nRuns \`${bin} ${driver.argv.join(" ")}\` from the app root.\n`
    return matter.stringify(`\n${body}\n`, {
      schema: "agentproto/driver/v1",
      id,
      name: `${name} — CLI Driver`,
      description: `CLI implementation of the ${id} tool contract.`,
      version,
      kind: "cli",
      implements: [
        {
          tool: id,
          version: `^${version}`,
          metadata: { cli: { argv: [...driver.argv], outputFormat: "json" } },
        },
      ],
      metadata: { cli: { bin } },
    })
  }
  const baseUrl = driver.baseUrl?.trim()
  if (!baseUrl) throw new Error("create_tool: a kind:http driver requires a non-empty `baseUrl`.")
  const body = `# ${name} — HTTP Driver\n\nDispatches to \`${baseUrl}\`.\n`
  return matter.stringify(`\n${body}\n`, {
    schema: "agentproto/driver/v1",
    id,
    name: `${name} — HTTP Driver`,
    description: `HTTP implementation of the ${id} tool contract.`,
    version,
    kind: "http",
    implements: [{ tool: id, version: `^${version}` }],
    metadata: {
      http: {
        baseUrl,
        ...(driver.method ? { defaultMethod: driver.method.toUpperCase() } : {}),
        ...(driver.path ? { path: driver.path } : {}),
      },
    },
  })
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
 * `Error` on a denied/absent caller identity, a bad id, an existing tool
 * without `force`, a `force` overwrite of a tool this mechanism did not author,
 * an overwrite inside `minLifetimeMs`, or a malformed driver.
 */
export async function createToolManifest(input: CreateToolInput): Promise<CreatedTool> {
  if (!TOOL_ID_PATTERN.test(input.id)) {
    throw new Error(
      `create_tool: invalid id '${input.id}' — must match ${TOOL_ID_PATTERN} (lowercase letter, then letters/digits/._-).`,
    )
  }
  const creatorAgent = await assertActionGranted(callerOf(input), GRANT_VERB, input.workspace)

  const now = input.now ?? Date.now
  const minLifetimeMs = input.minLifetimeMs ?? DEFAULT_MIN_LIFETIME_MS
  const version = input.version ?? "1.0.0"
  const name = input.name?.trim() || input.id
  const approval = input.approval ?? DEFAULT_CREATED_TOOL_APPROVAL

  const toolFile = toolPath(input.workspace, input.id)
  const driverFile = driverPath(input.workspace, input.id)
  const markerFile = authoringMarkerPath(input.workspace, input.id)
  const contents = await renderTool({
    id: input.id,
    name,
    description: input.description,
    version,
    approval,
    workspace: input.workspace,
    ...(input.inputs ? { inputs: input.inputs } : {}),
    ...(input.outputs ? { outputs: input.outputs } : {}),
  })
  const driverContents = renderDriver(input.id, name, input.driver, version)

  return withAuthoringLock(
    input.workspace,
    async () => {
      const marker = await readAuthoringMarker(markerFile)
      if (existsSync(toolFile)) {
        if (input.force !== true) {
          throw new Error(`create_tool: '${toolFile}' already exists (pass force: true to overwrite).`)
        }
        // Protect operator/`emitApp`-authored tools: only a tool this
        // mechanism created (marker present) may be overwritten.
        if (!marker) {
          throw new Error(
            `create_tool: refusing to overwrite '${toolFile}' — it was not authored by create_tool ` +
              `(no ${AUTHORING_MARKER_FILE} marker beside it). Operator / emitApp / hand-authored tools are protected; ` +
              `edit the file directly instead.`,
          )
        }
        await assertMinLifetime(toolFile, minLifetimeMs, now, "create_tool")
      }
      await mkdir(dirname(toolFile), { recursive: true })
      await mkdir(dirname(driverFile), { recursive: true })
      await writeFile(toolFile, contents, "utf8")
      await writeFile(driverFile, driverContents, "utf8")
      // Write the marker on first authoring; keep the original owner's record
      // on a later force-overwrite so ownership stays stable.
      if (!marker) {
        const next: AuthoringMarker = {
          createdAt: new Date(now()).toISOString(),
          creatorAgent,
          by: "create_tool",
        }
        await writeFile(markerFile, JSON.stringify(next, null, 2) + "\n", "utf8")
      }
      return { id: input.id, toolPath: toolFile, driverPath: driverFile }
    },
    {
      ...(input.authoringLockTtlMs !== undefined ? { ttlMs: input.authoringLockTtlMs } : {}),
      now,
    },
  )
}

export interface DeleteToolInput extends CallerIdentityInput {
  readonly workspace: string
  readonly id: string
  readonly now?: () => number
  readonly minLifetimeMs?: number
  readonly deleteLimit?: number
  readonly authoringLockTtlMs?: number
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
 * Delete a created tool's TOOL.md + DRIVER.md (+ its authoring marker), bounded
 * by `minLifetimeMs` and a per-agent/day `deleteLimit` (tombstones). Same
 * caller-bound grant as `create_tool`; refuses a tool this mechanism did not
 * author.
 */
export async function deleteToolManifest(input: DeleteToolInput): Promise<{ id: string; deleted: string[] }> {
  if (!TOOL_ID_PATTERN.test(input.id)) {
    throw new Error(`delete_tool: invalid id '${input.id}'.`)
  }
  const creatorAgent = await assertActionGranted(callerOf(input), GRANT_VERB, input.workspace)

  const now = input.now ?? Date.now
  const minLifetimeMs = input.minLifetimeMs ?? DEFAULT_MIN_LIFETIME_MS
  const deleteLimit = input.deleteLimit ?? DEFAULT_DELETE_LIMIT
  const toolFile = toolPath(input.workspace, input.id)
  const driverFile = driverPath(input.workspace, input.id)
  const markerFile = authoringMarkerPath(input.workspace, input.id)

  return withAuthoringLock(
    input.workspace,
    async () => {
      if (!existsSync(toolFile)) throw new Error(`delete_tool: '${toolFile}' does not exist.`)
      if (!(await readAuthoringMarker(markerFile))) {
        throw new Error(
          `delete_tool: refusing to delete '${toolFile}' — it was not authored by create_tool ` +
            `(no ${AUTHORING_MARKER_FILE} marker). Operator / emitApp / hand-authored tools are protected.`,
        )
      }
      await assertMinLifetime(toolFile, minLifetimeMs, now, "delete_tool")

      const at = now()
      const ledger = tombstonesPath(input.workspace)
      const state = await readTombstones(ledger)
      const today = dayKey(at)
      const entry = state[creatorAgent]
      const count = entry && entry.day === today ? entry.count : 0
      if (count >= deleteLimit) {
        throw new Error(
          `delete_tool: agent '${creatorAgent}' has reached its ${deleteLimit}-deletion/day limit — refusing to thrash.`,
        )
      }

      const deleted: string[] = []
      for (const path of [toolFile, driverFile, markerFile]) {
        if (existsSync(path)) {
          await rm(path, { force: true })
          deleted.push(path)
        }
      }
      state[creatorAgent] = { day: today, count: count + 1 }
      await mkdir(dirname(ledger), { recursive: true })
      await writeFile(ledger, JSON.stringify(state, null, 2) + "\n", "utf8")
      return { id: input.id, deleted }
    },
    {
      ...(input.authoringLockTtlMs !== undefined ? { ttlMs: input.authoringLockTtlMs } : {}),
      now,
    },
  )
}

/** The gateway verb that runs a created tool. */
export const CREATED_TOOL_CALL_VERB = "created_tool_call"

/** The approval `kind` a `created_tool_call` consumes. */
export const CREATED_TOOL_APPROVAL_KIND = "created_tool_call"

/** What a `created_tool_call` approval pins: the tool, the exact arguments,
 *  and a hash of the TOOL.md + DRIVER.md bytes AND every other file in the
 *  tool's bundle directory (`.agentproto/tools/<id>/`, the scripts the driver
 *  runs), so an approval cannot run a tool whose code changed after the human
 *  said yes. */
export interface CreatedToolApprovalPayload {
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly toolSha256: string
}

/** The exact approval request a caller has to make before the call can run. */
export interface CreatedToolApprovalRequest {
  readonly kind: typeof CREATED_TOOL_APPROVAL_KIND
  readonly title: string
  /** What the human should see: the payload plus the driver's command. */
  readonly preview: CreatedToolPreview
  readonly payload: CreatedToolApprovalPayload
}

/** Thrown when a call carries no approval: names the request to make. */
export class CreatedToolApprovalRequired extends Error {
  constructor(readonly request: CreatedToolApprovalRequest) {
    super(
      `${CREATED_TOOL_CALL_VERB}: tool '${request.payload.tool}' needs a human approval for this call. ` +
        `Call approval_request with this request, wait for the decision, then retry with its approvalId.`,
    )
    this.name = "CreatedToolApprovalRequired"
  }
}

export interface CallCreatedToolInput {
  readonly workspace: string
  readonly id: string
  readonly args: Record<string, unknown>
  readonly approvalId?: string
  /** The trusted caller, as the approvals engine names requesters. */
  readonly requester: ApprovalRequester
  readonly approvals?: ApprovalsEngine
}

export interface CreatedToolCallResult {
  readonly id: string
  readonly output: unknown
}

/**
 * Run a tool `create_tool` authored, once a human approved this exact call.
 * Order matters: the tool must carry the authoring marker, its bundle (and
 * only it) must load, then the approval is CONSUMED (approved, same
 * requester, same payload, never used before), and only then the driver
 * runs. A consumed approval is spent even when the driver then fails: one
 * approval, one attempt.
 */
export async function callCreatedTool(input: CallCreatedToolInput): Promise<CreatedToolCallResult> {
  const verb = CREATED_TOOL_CALL_VERB
  if (!TOOL_ID_PATTERN.test(input.id)) {
    throw new Error(`${verb}: invalid id '${input.id}', it must match ${TOOL_ID_PATTERN}.`)
  }
  const marker = await readAuthoringMarker(authoringMarkerPath(input.workspace, input.id))
  if (!marker || !existsSync(toolPath(input.workspace, input.id))) {
    throw new Error(
      `${verb}: '${input.id}' is not a tool create_tool authored in this workspace ` +
        `(no ${AUTHORING_MARKER_FILE} marker). Only created tools run through ${verb}.`,
    )
  }

  // Snapshot ONLY this bundle, before any approval is touched: a malformed
  // file elsewhere in the workspace cannot break the call, and a broken
  // bundle fails here without spending the human's approval. The snapshot is
  // read once into memory, hashed, and written to a private temp root that
  // the driver then runs from: what was hashed (and approved) is exactly what
  // executes, and a later edit of the workspace files cannot reach it.
  const snap = await snapshotCreatedTool(input.workspace, input.id, input.args).catch(err => {
    throw new Error(`${verb}: ${err instanceof Error ? err.message : String(err)}`)
  })
  try {
    if (input.approvalId === undefined || input.approvalId.trim() === "") {
      throw new CreatedToolApprovalRequired({
        kind: CREATED_TOOL_APPROVAL_KIND,
        title: snap.title,
        preview: snap.preview,
        payload: snap.payload,
      })
    }
    if (!input.approvals) {
      throw new Error(`${verb}: no approvals engine on this surface, refusing (default DENY).`)
    }
    const record = input.approvals.get(input.approvalId)
    if (!record) throw new Error(`${verb}: no approval ${input.approvalId}.`)
    if (record.kind !== CREATED_TOOL_APPROVAL_KIND) {
      throw new Error(
        `${verb}: approval ${input.approvalId} is of kind '${record.kind}', not '${CREATED_TOOL_APPROVAL_KIND}'.`,
      )
    }
    // Throws on not approved / other requester / payload drift (other args, or
    // the tool's files changed since the approval) / already consumed.
    input.approvals.consume(input.approvalId, input.requester, snap.payload)

    const output = await runTool({
      tool: snap.bundle.tool,
      // Only the driver filed under this id, never another driver in the
      // workspace that happens to implement the same contract.
      candidates: [snap.bundle.driver],
      input: input.args,
    })
    return { id: input.id, output }
  } finally {
    await snap.cleanup()
  }
}

/** What the human is shown for a created-tool approval. Always generated
 *  daemon-side from the real bundle, never taken from the requesting agent. */
export interface CreatedToolPreview extends CreatedToolApprovalPayload {
  readonly driver: Record<string, unknown>
  /** Every file the hash covers, with its own sha256. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>
  /** sha256 of an absolute `bin` outside the workspace, pinned by the hash. */
  readonly binSha256?: string
}

interface CreatedToolSnapshot {
  readonly bundle: LoadedBundledTool
  readonly payload: CreatedToolApprovalPayload
  readonly title: string
  readonly preview: CreatedToolPreview
  readonly cleanup: () => Promise<void>
}

const MAX_BUNDLE_FILES = 64
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024

const sha256 = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex")

/** Read every file under `dir` once (no symlinks, bounded), sorted by path. */
async function readBundleFiles(dir: string): Promise<Array<{ path: string; bytes: Buffer }>> {
  const out: Array<{ path: string; bytes: Buffer }> = []
  let total = 0
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const name of (await readdir(abs)).sort()) {
      const childRel = rel === "" ? name : `${rel}/${name}`
      if (childRel === AUTHORING_MARKER_FILE) continue // written by the daemon itself
      const childAbs = join(abs, name)
      // O_NOFOLLOW + fstat on the opened fd: no gap between "is it a symlink"
      // and "read it" for a swap to land in.
      const fh = await open(childAbs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ELOOP" || err.code === "EMLINK") {
          throw new Error(`'${childRel}' in the tool bundle is a symlink, refusing.`)
        }
        throw err
      })
      let st: Awaited<ReturnType<typeof fh.stat>>
      let bytes: Buffer | undefined
      try {
        st = await fh.stat()
        if (st.isFile()) bytes = await fh.readFile()
      } finally {
        await fh.close()
      }
      if (st.isDirectory()) {
        await walk(childAbs, childRel)
      } else if (st.isFile() && bytes) {
        total += bytes.length
        if (out.length + 1 > MAX_BUNDLE_FILES || total > MAX_BUNDLE_BYTES) {
          throw new Error(`the tool bundle exceeds ${MAX_BUNDLE_FILES} files / ${MAX_BUNDLE_BYTES} bytes, refusing.`)
        }
        out.push({ path: childRel, bytes })
      } else {
        throw new Error(`'${childRel}' in the tool bundle is not a regular file, refusing.`)
      }
    }
  }
  await walk(dir, "")
  return out
}

/** Nothing a created tool executes may live where the agent can rewrite it
 *  unseen. The script must be in `.agentproto/tools/<id>/`, the only directory
 *  the approval hash covers: no `cwd`, and every literal `binArgs`/`argv` token
 *  is bundle-relative (absolute or `..` paths are refused). `bin` is one of:
 *  a bare command name resolved on PATH (`node`: a system interpreter, never
 *  resolved against the workspace); a bundle-relative path (staged and hashed
 *  with the bundle); or an absolute path OUTSIDE the workspace, whose bytes the
 *  caller hashes into the approval (returned here). An absolute `bin` inside
 *  the workspace, or any `..` path, is refused. `${input.x}` tokens are data,
 *  pinned by the approved `args`. Returns the absolute `bin` to hash, if any. */
async function assertArgvInsideBundle(id: string, driverBytes: string, workspace: string): Promise<string | undefined> {
  const fm = matter(driverBytes).data as {
    kind?: unknown
    metadata?: { cli?: { bin?: unknown; binArgs?: unknown; cwd?: unknown } }
    implements?: Array<{ metadata?: { cli?: { argv?: unknown } } }>
  }
  if (fm.kind !== "cli") return undefined
  if (fm.metadata?.cli?.cwd !== undefined) {
    throw new Error(`driver '${id}' sets metadata.cli.cwd; a created tool runs from its own bundle, refusing.`)
  }
  const tokens: unknown[] = []
  if (Array.isArray(fm.metadata?.cli?.binArgs)) tokens.push(...fm.metadata.cli.binArgs)
  for (const impl of fm.implements ?? []) {
    if (Array.isArray(impl.metadata?.cli?.argv)) tokens.push(...impl.metadata.cli.argv)
  }
  const escapes = (t: string): boolean =>
    t.startsWith("/") || t.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(t) || t.split(/[\\/]/).some(seg => seg === "..")
  const refuse = (what: string, t: string): never => {
    throw new Error(
      `driver '${id}' ${what} '${t}' points outside the tool bundle (.agentproto/tools/${id}/), ` +
        `whose files are the only ones the approval covers. Refusing.`,
    )
  }
  const isAbs = (t: string): boolean => t.startsWith("/") || t.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(t)
  const dotdot = (t: string): boolean => t.split(/[\\/]/).some(seg => seg === "..")
  const bin = fm.metadata?.cli?.bin
  let hashBin: string | undefined
  if (typeof bin === "string" && !bin.startsWith("${")) {
    if (dotdot(bin)) refuse("bin", bin)
    if (isAbs(bin)) {
      const real = await realpath(bin).catch(() => {
        throw new Error(`driver '${id}' bin '${bin}' does not exist.`)
      })
      const rel = relative(await realpath(workspace), real)
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) refuse("bin", bin)
      hashBin = real
    }
  }
  for (const t of tokens) {
    if (typeof t !== "string" || t.startsWith("${")) continue
    if (escapes(t)) refuse("argv", t)
  }
  return hashBin
}

async function hashFile(path: string): Promise<string> {
  const h = createHash("sha256")
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest("hex")
}

/**
 * Snapshot one created tool: read its whole bundle once, hash it, stage it in
 * a private temp root, and load the handles from the staged copy.
 */
async function snapshotCreatedTool(
  workspace: string,
  id: string,
  args: Record<string, unknown>,
): Promise<CreatedToolSnapshot> {
  const toolSource = await readFile(toolPath(workspace, id), "utf8").catch(() => {
    throw new Error(`tool '${id}': cannot read ${toolPath(workspace, id)}`)
  })
  const driverSource = await readFile(driverPath(workspace, id), "utf8").catch(() => {
    throw new Error(`driver '${id}': cannot read ${driverPath(workspace, id)}`)
  })
  const toolDir = join(workspace, ".agentproto", "tools", id)
  const files = (await readBundleFiles(toolDir)).filter(f => f.path !== "TOOL.md")
  const absBin = await assertArgvInsideBundle(id, driverSource, workspace)
  const binSha256 = absBin ? await hashFile(absBin) : undefined

  const stage = await mkdtemp(join(tmpdir(), "created-tool-"))
  const cleanup = (): Promise<void> => rm(stage, { recursive: true, force: true })
  try {
    const stageTool = join(stage, ".agentproto", "tools", id)
    await mkdir(stageTool, { recursive: true })
    await mkdir(join(stage, ".agentproto", "drivers", id), { recursive: true })
    await writeFile(join(stageTool, "TOOL.md"), toolSource, "utf8")
    await writeFile(join(stage, ".agentproto", "drivers", id, "DRIVER.md"), driverSource, "utf8")
    for (const f of files) {
      const dest = join(stageTool, ...f.path.split(posix.sep))
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, f.bytes, { mode: 0o700 })
    }
    const bundle = await loadBundledTool(stage, id)
    const hash = createHash("sha256").update(bundle.toolSource).update("\0").update(bundle.driverSource)
    const covered = files.map(f => ({ path: f.path, sha256: sha256(f.bytes) }))
    for (const f of covered) hash.update("\0").update(f.path).update("\0").update(f.sha256)
    if (absBin && binSha256) hash.update("\0bin\0").update(absBin).update("\0").update(binSha256)
    const payload: CreatedToolApprovalPayload = { tool: id, args, toolSha256: hash.digest("hex") }
    return {
      bundle,
      payload,
      title: `Run created tool ${id}`,
      preview: { ...payload, driver: driverSummary(bundle.driverSource), files: covered, ...(binSha256 ? { binSha256 } : {}) },
      cleanup,
    }
  } catch (err) {
    await cleanup()
    throw err
  }
}

/**
 * The title + preview a human is shown for a `created_tool_call` approval,
 * generated from the real bundle and the requested payload. Called by
 * `approval_request`: a caller-supplied title/preview never replaces it. Throws
 * when the payload is malformed, names no authored tool, or carries a hash that
 * is not the bundle's current one (the agent must request exactly what a
 * `created_tool_call` made without an approval returned).
 */
export async function describeCreatedToolApproval(
  workspace: string,
  payload: unknown,
): Promise<{ title: string; preview: CreatedToolPreview }> {
  const p = payload as Partial<CreatedToolApprovalPayload> | null
  if (
    !p ||
    typeof p !== "object" ||
    typeof p.tool !== "string" ||
    !TOOL_ID_PATTERN.test(p.tool) ||
    typeof p.toolSha256 !== "string" ||
    typeof p.args !== "object" ||
    p.args === null ||
    Array.isArray(p.args)
  ) {
    throw new Error(`${CREATED_TOOL_APPROVAL_KIND}: payload must be { tool, args, toolSha256 }.`)
  }
  const marker = await readAuthoringMarker(authoringMarkerPath(workspace, p.tool))
  if (!marker) throw new Error(`${CREATED_TOOL_APPROVAL_KIND}: '${p.tool}' is not a tool create_tool authored.`)
  const snap = await snapshotCreatedTool(workspace, p.tool, p.args as Record<string, unknown>)
  try {
    if (snap.payload.toolSha256 !== p.toolSha256) {
      throw new Error(
        `${CREATED_TOOL_APPROVAL_KIND}: toolSha256 does not match the tool's current files. ` +
          `Request exactly the payload ${CREATED_TOOL_CALL_VERB} returned.`,
      )
    }
    return { title: snap.title, preview: snap.preview }
  } finally {
    await snap.cleanup()
  }
}

/** The DRIVER.md fields a human needs to judge the call: what runs. */
function driverSummary(driverBytes: string): Record<string, unknown> {
  if (driverBytes === "") return {}
  try {
    const fm = matter(driverBytes).data as {
      kind?: unknown
      metadata?: { cli?: { bin?: unknown }; http?: unknown }
      implements?: Array<{ metadata?: { cli?: { argv?: unknown } } }>
    }
    return {
      kind: fm.kind,
      ...(fm.metadata?.cli?.bin !== undefined ? { bin: fm.metadata.cli.bin } : {}),
      ...(fm.implements?.[0]?.metadata?.cli?.argv !== undefined ? { argv: fm.implements[0].metadata.cli.argv } : {}),
      ...(fm.metadata?.http !== undefined ? { http: fm.metadata.http } : {}),
    }
  } catch {
    return {}
  }
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

export interface RegisterCreateToolOptions extends CallerIdentity {
  readonly workspace: string
  /** The daemon's approvals engine. Without it `created_tool_call` refuses
   *  every call (fail closed). */
  readonly approvals?: ApprovalsEngine
}

/** Register `create_tool` + `delete_tool`. The workspace AND the authenticated
 *  caller identity are injected at registration time; the caller supplies only
 *  the logical tool id + description. A `agentId` passed in the payload is
 *  ignored — the grant subject is always the daemon-resolved caller. */
export function registerCreateToolTools(server: McpServer, opts: RegisterCreateToolOptions): void {
  const caller: CallerIdentityInput = {
    ...(opts.agentId !== undefined ? { callerAgentId: opts.agentId } : {}),
    ...(opts.manifestPath !== undefined ? { callerAgentManifestPath: opts.manifestPath } : {}),
    ...(opts.sessionId !== undefined ? { callerSessionId: opts.sessionId } : {}),
  }
  server.tool(
    "create_tool",
    "Author an AIP-14/AIP-30 tool pair (`.agentproto/tools/<id>/TOOL.md` + " +
      "`.agentproto/drivers/<id>/DRIVER.md`) in this workspace. GATED by the CALLER'S own " +
      "AIP-42 manifest `actions.granted` (default-denied; the daemon resolves the caller " +
      "identity — no agent id is accepted from the payload). A tool cannot be overwritten " +
      "before its minimum lifetime, and only a tool this verb authored may be overwritten. " +
      "Use `delete_tool` to remove one (bounded by a per-day delete limit). Created tools " +
      'default to approval:"always".',
    {
      id: z.string().describe("AIP-14 tool id (regex ^[a-z][a-z0-9._-]{1,63}$)."),
      description: z.string().min(1).describe("One-paragraph purpose."),
      driver: z
        .object({
          kind: z.enum(["cli", "http"]),
          bin: z.string().optional().describe("kind:cli binary (e.g. \"node\")."),
          argv: z
            .array(z.string())
            .optional()
            .describe("kind:cli argv (script + args). `${input.<name>}` is replaced by that input. stdout must be JSON."),
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
      force: z.boolean().optional().describe("Overwrite an authored tool (still bounded by marker + minLifetime)."),
    },
    async input => {
      try {
        const created = await createToolManifest({
          workspace: opts.workspace,
          id: input.id,
          description: input.description,
          driver: input.driver,
          ...caller,
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
    CREATED_TOOL_CALL_VERB,
    "Run a tool that `create_tool` authored in this workspace, by id. Every call needs a " +
      "human-approved approval. Call it once without `approvalId`: it is refused with the exact " +
      "`approval_request` to make (kind \"created_tool_call\", payload `{ tool, args, toolSha256 }`). " +
      "Make that request, wait for the human (`approval_wait`), then call this again with the same " +
      "`id`, the same `args` and the `approvalId`. One approval runs the tool once; it is void if " +
      "the tool's files change.",
    {
      id: z.string().describe("Id of a tool create_tool authored."),
      args: z.record(z.string(), z.unknown()).optional().describe("Tool inputs. Default: empty object."),
      approvalId: z
        .string()
        .optional()
        .describe("An approved `created_tool_call` approval this session requested for exactly this id + args."),
    },
    async input => {
      try {
        const result = await callCreatedTool({
          workspace: opts.workspace,
          id: input.id,
          args: input.args ?? {},
          ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
          requester: opts.sessionId ? { sessionId: opts.sessionId } : { operator: true },
          ...(opts.approvals ? { approvals: opts.approvals } : {}),
        })
        return ok(result)
      } catch (err) {
        if (err instanceof CreatedToolApprovalRequired) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "approval_required", message: err.message, request: err.request }),
              },
            ],
          }
        }
        return fail(err)
      }
    },
  )

  server.tool(
    "delete_tool",
    "Remove a created AIP-14/AIP-30 tool pair, bounded by its minimum lifetime and a " +
      "per-agent/day delete limit. Same caller-bound `actions.granted` gate as `create_tool`.",
    {
      id: z.string().describe("AIP-14 tool id to remove."),
    },
    async input => {
      try {
        const result = await deleteToolManifest({
          workspace: opts.workspace,
          id: input.id,
          ...caller,
        })
        return ok(result)
      } catch (err) {
        return fail(err)
      }
    },
  )
}
