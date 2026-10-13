/**
 * A2A task ingress — the store + mapping half (the HTTP half is
 * a2a-task-http.ts). One A2A task is one `app_run` (an agent skill) or one
 * background workflow run (a workflow skill): the task id IS the run id, and
 * everything about a task's state is derived from that run, never held
 * separately. The only thing persisted here is a small append-only ledger of
 * which runs were created through A2A (and for which skill + kind), so
 * `GetTask` can tell an A2A task from an ordinary run and survives a daemon
 * restart.
 *
 * The JSON-RPC / Task shapes below are the subset of the A2A protocol
 * (`A2A_PROTOCOL_VERSION`) this ingress speaks, defined locally on purpose so
 * the runtime does not depend on `@agentproto/a2a`.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"

/** A2A spec version the field names and error codes below follow. */
export const A2A_PROTOCOL_VERSION = "1.0"

/** `Major.Minor` versions this ingress serves. */
export const A2A_SUPPORTED_VERSIONS: readonly string[] = [A2A_PROTOCOL_VERSION]

/** Resolve the requested version from the `A2A-Version` header, else the
 *  `?version=` query param. Neither given defaults to 1.0: this daemon never
 *  shipped 0.3, so there is no legacy client to stay compatible with. */
export function negotiateVersion(
  header: string | undefined,
  query: string | null | undefined,
): { version: string; supported: boolean } {
  const version = header?.trim() || query?.trim() || A2A_PROTOCOL_VERSION
  return { version, supported: A2A_SUPPORTED_VERSIONS.includes(version) }
}

// ── JSON-RPC 2.0 ───────────────────────────────────────────────────────

export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: JsonRpcError }

export const JSON_RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
  invalidAgentResponse: -32006,
  extendedAgentCardNotConfigured: -32007,
  extensionSupportRequired: -32008,
  versionNotSupported: -32009,
} as const

// ── A2A Task shapes ────────────────────────────────────────────────────

export type A2aTaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED"

/** Flat oneof (ProtoJSON): exactly one of `text` / `raw` (base64 bytes) /
 *  `url` / `data` is set; there is no `kind` discriminator. */
export type A2aPart = {
  metadata?: Record<string, unknown>
  filename?: string
  mediaType?: string
} & ({ text: string } | { raw: string } | { url: string } | { data: unknown })

export interface A2aMessage {
  messageId: string
  contextId?: string
  taskId?: string
  role: "ROLE_USER" | "ROLE_AGENT"
  parts: A2aPart[]
  metadata?: Record<string, unknown>
  extensions?: string[]
  referenceTaskIds?: string[]
}

export interface A2aArtifact {
  artifactId: string
  name?: string
  description?: string
  parts: A2aPart[]
  metadata?: Record<string, unknown>
  extensions?: string[]
}

export interface A2aTask {
  id: string
  contextId?: string
  status: { state: A2aTaskState; message?: A2aMessage; timestamp?: string }
  artifacts?: A2aArtifact[]
  history?: A2aMessage[]
  metadata?: Record<string, unknown>
}

/** `SendMessage` result: a oneof wrapper, `{task}` or `{message}`. */
export type A2aSendMessageResponse = { task: A2aTask } | { message: A2aMessage }

export const TERMINAL_TASK_STATES: ReadonlySet<A2aTaskState> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
])

// ── manifest surface (lane 2's `handle.accepts` / `handle.exposes`) ────

/** Narrow view of the manifest fields this ingress reads. Every field is
 *  optional: an app whose manifest predates them accepts nothing and exposes
 *  nothing (never "everything"). */
export interface A2aAppHandleLike {
  accepts?: { tasks?: boolean }
  exposes?: { agents?: readonly string[]; workflows?: readonly string[] }
  /** The app's bundled workflows (id + file path), used to start an exposed
   *  workflow skill. Absent when the manifest bundles none. */
  workflows?: readonly { id: string; path: string }[]
}

export type A2aSkillTarget = { kind: "agent"; id: string } | { kind: "workflow"; id: string }

export function resolveExposedSkill(
  handle: A2aAppHandleLike,
  skill: string,
): A2aSkillTarget | undefined {
  if (handle.exposes?.agents?.includes(skill)) return { kind: "agent", id: skill }
  if (handle.exposes?.workflows?.includes(skill)) return { kind: "workflow", id: skill }
  return undefined
}

const SKILL_PREFIX_RE = /^\s*skill:\s*(\S+)\s*([\s\S]*)$/

/**
 * Pull the requested skill and the prompt text out of a `SendMessage`
 * message. `metadata.skill` wins; otherwise the first text part may begin
 * `skill:<id>` (the remainder of that part stays in the prompt). A skill id
 * written in Agent Card form (`<appId>/<skillId>`) is accepted too.
 */
export function extractSkillRequest(
  message: { parts: readonly A2aPart[]; metadata?: Record<string, unknown> },
  appId: string,
  paramsMetadata?: Record<string, unknown>,
): { skill?: string; prompt: string } {
  const texts: string[] = []
  let prefixed: string | undefined
  let firstText = true
  for (const part of message.parts) {
    if (!("text" in part) || typeof part.text !== "string") continue
    if (firstText) {
      firstText = false
      const m = SKILL_PREFIX_RE.exec(part.text)
      if (m) {
        prefixed = m[1]
        if (m[2]!.trim()) texts.push(m[2]!.trim())
        continue
      }
    }
    texts.push(part.text)
  }
  const explicit = [message.metadata?.skill, paramsMetadata?.skill].find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  )
  let skill = explicit?.trim() ?? prefixed
  if (skill !== undefined && skill.startsWith(`${appId}/`)) skill = skill.slice(appId.length + 1)
  return { ...(skill !== undefined ? { skill } : {}), prompt: texts.join("\n\n").trim() }
}

// ── run → task mapping ─────────────────────────────────────────────────

/** The `descriptor` an `app_status` session carries (`full: true`). */
export interface A2aSessionDescriptor {
  status?: string
  busy?: boolean
  awaitingInput?: boolean
  turnsCompleted?: number
  outcome?: { summary?: string }
  /** Set when the last turn errored, cleared when a later turn completes
   *  cleanly (mirrors `SessionDescriptor.lastTurnErroredAt`). */
  lastTurnErroredAt?: string
  /** Captured error text for `lastTurnErroredAt`. */
  lastTurnErrorMessage?: string
  /** The last completed turn's end reason (`"completed"`, `"error"`,
   *  `"aborted"`, …). */
  lastTurnReason?: string
  /** ISO timestamp of the session's most recent activity. */
  lastActivityAt?: string
}

/** One entry of `app_status`'s `sessions` array. */
export interface A2aRunSession {
  agentId?: string
  sessionId?: string
  descriptor?: A2aSessionDescriptor
}

/**
 * True when this session's current turn is finished: it is no longer running
 * at all, or it has completed at least one turn and is neither busy nor
 * waiting on input (an agent-cli session stays `running`/idle after its turn
 * ends, until the idle reaper retires it).
 */
export function sessionTurnDone(desc: A2aSessionDescriptor): boolean {
  if (desc.status !== "running" && desc.status !== "starting") return true
  return (
    (desc.turnsCompleted ?? 0) >= 1 && desc.busy !== true && desc.awaitingInput !== true
  )
}

/**
 * True when this session's last turn ended in error: `lastTurnErroredAt` is a
 * non-empty string, or the turn ended with reason `"error"`. `"aborted"` (and
 * any other reason) is not a failure.
 */
export function sessionTurnFailed(desc: A2aSessionDescriptor): boolean {
  return (
    (typeof desc.lastTurnErroredAt === "string" && desc.lastTurnErroredAt !== "") ||
    desc.lastTurnReason === "error"
  )
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** `app_status`'s reconciled run status → A2A task state. A run that is
 *  still `running` with no session yet is submitted; once a session exists it
 *  is working — unless every session carries a descriptor whose turn is done
 *  (see `sessionTurnDone`), in which case the run is completed even though the
 *  run status itself has not reconciled yet — unless any of those turns ended
 *  in error (see `sessionTurnFailed`), which makes the task failed. A session
 *  with no descriptor (a slim `app_status` reply) keeps the
 *  submitted/working behaviour. An unrecognised status is treated as failed
 *  (1.0 has no `unknown` state). */
export function mapRunState(run: { status?: string; sessions?: readonly unknown[] }): A2aTaskState {
  switch (run.status) {
    case "succeeded":
      return "TASK_STATE_COMPLETED"
    case "failed":
      return "TASK_STATE_FAILED"
    case "cancelled":
      return "TASK_STATE_CANCELED"
    case "running": {
      const sessions = run.sessions ?? []
      if (sessions.length === 0) return "TASK_STATE_SUBMITTED"
      let failed = false
      for (const s of sessions) {
        if (!isPlainObject(s) || !isPlainObject(s.descriptor)) return "TASK_STATE_WORKING"
        const desc = s.descriptor as A2aSessionDescriptor
        if (!sessionTurnDone(desc)) return "TASK_STATE_WORKING"
        if (sessionTurnFailed(desc)) failed = true
      }
      return failed ? "TASK_STATE_FAILED" : "TASK_STATE_COMPLETED"
    }
    default:
      return "TASK_STATE_FAILED"
  }
}

/** The subset of an `app_status` reply the task view is built from. */
export interface A2aRunView {
  appRunId: string
  appId?: string
  status?: string
  endedAt?: string
  error?: string
  sessions?: readonly A2aRunSession[]
}

/** One agent's answer, ready to become an A2A artifact + status message. */
export interface A2aAgentOutput {
  agentId: string
  text: string
}

const CONVERSATION_WINDOW_SUFFIX = "\n\n---\n[window:"

/**
 * Pull the last assistant reply out of a `conversation_read` `format:"json"`
 * text: JSON `{meta, messages}` FOLLOWED BY a non-JSON window suffix like
 * `"\n\n---\n[window: messages 1–2 of 3]"`, so the suffix is cut before
 * parsing. Returns the `text` of the last `assistant` message with a non-blank
 * text, else undefined (unparseable text, no messages, or all blank).
 */
export function extractLastAssistantText(text: string): string | undefined {
  const cut = text.split(CONVERSATION_WINDOW_SUFFIX)[0] ?? text
  let parsed: unknown
  try {
    parsed = JSON.parse(cut)
  } catch {
    return undefined
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.messages)) {
    return undefined
  }
  const messages = parsed.messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!isPlainObject(m)) continue
    if (m.role !== "assistant" || typeof m.text !== "string" || m.text.trim() === "") continue
    return m.text
  }
  return undefined
}

export function buildTask(input: {
  entry: A2aLedgerEntry
  run: A2aRunView
  artifacts?: A2aArtifact[]
  agentOutputs?: A2aAgentOutput[]
  newId: () => string
}): A2aTask {
  const { entry, run } = input
  const state = mapRunState(run)
  const outputs = state === "TASK_STATE_COMPLETED" ? (input.agentOutputs ?? []) : []
  // The turn-done rule (run still `running`, every session's turn finished) —
  // the only place a FAILED task can carry a per-session turn error.
  const turnEnded =
    run.status === "running" && (state === "TASK_STATE_COMPLETED" || state === "TASK_STATE_FAILED")
  const agentMessage = (text: string): A2aMessage => ({
    messageId: input.newId(),
    role: "ROLE_AGENT" as const,
    parts: [{ text }],
    taskId: entry.taskId,
    contextId: entry.contextId,
  })
  const turnErrorText = turnEnded && state === "TASK_STATE_FAILED" ? failedTurnText(run) : undefined
  const message =
    state === "TASK_STATE_FAILED" && run.error
      ? agentMessage(run.error)
      : turnErrorText !== undefined
        ? agentMessage(turnErrorText)
        : state === "TASK_STATE_COMPLETED" && outputs.length > 0
          ? agentMessage(
              outputs.length === 1 ? outputs[0]!.text : outputs.map(o => `[${o.agentId}]\n${o.text}`).join("\n\n"),
            )
          : undefined
  const artifacts = [
    ...outputs.map(o => ({
      artifactId: `agent-output-${o.agentId}`,
      name: o.agentId,
      parts: [{ text: o.text }],
    })),
    ...(input.artifacts ?? []),
  ]
  const activityIso = turnEnded ? latestActivityIso(run.sessions) : undefined
  const task: A2aTask = {
    id: entry.taskId,
    contextId: entry.contextId,
    status: {
      state,
      timestamp: activityIso ?? run.endedAt ?? entry.createdAt,
      ...(message ? { message } : {}),
    },
    metadata: { appId: entry.appId, skill: entry.skill },
  }
  if (state === "TASK_STATE_COMPLETED" && artifacts.length > 0) {
    task.artifacts = artifacts
  }
  return task
}

/** Text for a FAILED task whose sessions' turns ended in error: the
 *  `lastTurnErrorMessage` values (joined `[agentId] <msg>` when several
 *  sessions carry one); `"agent turn failed"` when none is present. */
function failedTurnText(run: A2aRunView): string | undefined {
  const errored = (run.sessions ?? []).filter(s => s.descriptor && sessionTurnFailed(s.descriptor))
  if (errored.length === 0) return undefined
  const texts = errored.flatMap(s => {
    const msg = s.descriptor?.lastTurnErrorMessage
    return typeof msg === "string" && msg !== "" ? [{ agentId: s.agentId, msg }] : []
  })
  if (texts.length === 0) return "agent turn failed"
  if (texts.length === 1) return texts[0]!.msg
  return texts.map(t => `[${t.agentId ?? "?"}] ${t.msg}`).join("\n")
}

/** Latest valid-ISO `descriptor.lastActivityAt` across the sessions, if any. */
function latestActivityIso(sessions: readonly A2aRunSession[] | undefined): string | undefined {
  let latest: string | undefined
  let latestMs = -Infinity
  for (const s of sessions ?? []) {
    const ts = s.descriptor?.lastActivityAt
    if (typeof ts !== "string" || ts === "") continue
    const ms = Date.parse(ts)
    if (!Number.isFinite(ms)) continue
    if (ms > latestMs) {
      latestMs = ms
      latest = ts
    }
  }
  return latest
}

// ── workflow run → task mapping ────────────────────────────────────────

/** The subset of a `workflow_status` reply the task view is built from. */
export interface A2aWorkflowRunView {
  status?: string
  endedAt?: string
  updatedAt?: string
  output?: unknown
  error?: string
}

/** A `workflow_status` status → A2A task state: `running`/`idle` is working,
 *  either awaiting-input form is input-required (1.0 has no approval state),
 *  `done` is completed, `failed` is failed, `cancelled` is canceled, and any
 *  unrecognised status keeps the task working (1.0 has no `unknown` state). */
export function mapWorkflowState(status: string): A2aTaskState {
  switch (status) {
    case "awaiting-input":
    case "awaiting-approval":
      return "TASK_STATE_INPUT_REQUIRED"
    case "done":
      return "TASK_STATE_COMPLETED"
    case "failed":
      return "TASK_STATE_FAILED"
    case "cancelled":
      return "TASK_STATE_CANCELED"
    case "running":
    case "idle":
    default:
      return "TASK_STATE_WORKING"
  }
}

/**
 * Build the A2A task for a workflow-backed ledger entry from its
 * `workflow_status` — the workflow twin of `buildTask`. A `done` run carries
 * one artifact named `output` (a `data` part when the output is an object,
 * else a `text` part of `String(output)`); a `failed` run carries the run's
 * error as a `ROLE_AGENT` status message (no artifacts). The timestamp is
 * the run's end, else its last update, else the ledger entry's creation.
 */
export function buildWorkflowTask(input: {
  entry: A2aLedgerEntry
  run: A2aWorkflowRunView
  newId: () => string
}): A2aTask {
  const { entry, run } = input
  const state = mapWorkflowState(run.status ?? "")
  const task: A2aTask = {
    id: entry.taskId,
    contextId: entry.contextId,
    status: {
      state,
      timestamp: run.endedAt ?? run.updatedAt ?? entry.createdAt,
    },
    metadata: { appId: entry.appId, skill: entry.skill },
  }
  if (state === "TASK_STATE_COMPLETED" && run.output !== undefined) {
    const output = run.output
    const part: A2aPart =
      typeof output === "object" && output !== null ? { data: output } : { text: String(output) }
    task.artifacts = [{ artifactId: "output", name: "output", parts: [part] }]
  }
  if (state === "TASK_STATE_FAILED") {
    task.status.message = {
      messageId: input.newId(),
      role: "ROLE_AGENT",
      parts: [{ text: run.error || "workflow failed" }],
      taskId: entry.taskId,
      contextId: entry.contextId,
    }
  }
  return task
}

/** Map an `app_artifact_get` reply (the app's HTML dashboard artifact) to
 *  A2A artifacts. */
export function mapAppArtifact(reply: {
  title?: unknown
  description?: unknown
  html?: unknown
}): A2aArtifact[] {
  if (typeof reply.html !== "string") return []
  const name = typeof reply.title === "string" ? reply.title : undefined
  return [
    {
      artifactId: "app-artifact",
      ...(name !== undefined ? { name } : {}),
      ...(typeof reply.description === "string" ? { description: reply.description } : {}),
      parts: [
        {
          raw: Buffer.from(reply.html, "utf8").toString("base64"),
          mediaType: "text/html",
          filename: `${(name ?? "artifact").replace(/[^\w.-]+/g, "-")}.html`,
        },
      ],
    },
  ]
}

// ── task ledger ────────────────────────────────────────────────────────

export interface A2aLedgerEntry {
  taskId: string
  appId: string
  contextId: string
  skill: string
  createdAt: string
  /** What backs the task: an `app_run` (agent skill) or a background
   *  workflow run (workflow skill). Absent on entries written before the
   *  field existed — they read as `"agent"`. */
  kind?: "agent" | "workflow"
}

export interface A2aTaskLedger {
  append(entry: A2aLedgerEntry): Promise<void>
  find(appId: string, taskId: string): Promise<A2aLedgerEntry | undefined>
}

/** Append-only JSONL ledger, one file per app: `<dir>/<encoded appId>.jsonl`
 *  (the id is URI-encoded so a scoped `@scope/name` stays one path segment). */
export function createA2aTaskLedger(dir: string): A2aTaskLedger {
  const fileFor = (appId: string): string => join(dir, `${encodeURIComponent(appId)}.jsonl`)
  return {
    async append(entry) {
      await mkdir(dir, { recursive: true })
      await appendFile(fileFor(entry.appId), `${JSON.stringify(entry)}\n`, "utf8")
    },
    async find(appId, taskId) {
      let raw: string
      try {
        raw = await readFile(fileFor(appId), "utf8")
      } catch {
        return undefined
      }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as A2aLedgerEntry
          if (entry.taskId === taskId && entry.appId === appId) return entry
        } catch {
          // A torn trailing line from a crash mid-append is skipped.
        }
      }
      return undefined
    },
  }
}

// ── daemon tool result envelope ────────────────────────────────────────

/** Unwrap a `dispatchTool` reply (an MCP `{content:[{type:"text",text}],
 *  isError?}` envelope) into `{ok, data|text}`: the text is JSON-parsed when
 *  it parses. */
export function unwrapToolResult(
  result: unknown,
): { ok: boolean; data: Record<string, unknown> | undefined; text: string } {
  let text = ""
  let ok = true
  if (typeof result === "string") text = result
  else if (result && typeof result === "object") {
    const env = result as { content?: unknown; isError?: unknown }
    ok = env.isError !== true
    if (Array.isArray(env.content)) {
      text = env.content
        .map(c => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
        .join("")
    }
  }
  let data: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
  } catch {
    // Non-JSON text (an error message) — callers read `text`.
  }
  return { ok, data, text }
}
