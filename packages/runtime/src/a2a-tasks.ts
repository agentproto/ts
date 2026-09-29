/**
 * A2A task ingress — the store + mapping half (the HTTP half is
 * a2a-task-http.ts). One A2A task is one `app_run`: the task id IS the app run
 * id, and everything about a task's state is derived from that run, never
 * held separately. The only thing persisted here is a small append-only
 * ledger of which runs were created through A2A (and for which skill), so
 * `GetTask` can tell an A2A task from an ordinary `app_run` and survives a
 * daemon restart.
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

/** `app_status`'s reconciled run status → A2A task state. A run that is
 *  still `running` with no session yet is submitted; once a session exists it
 *  is working. An unrecognised status is treated as failed (1.0 has no
 *  `unknown` state). */
export function mapRunState(run: { status?: string; sessions?: readonly unknown[] }): A2aTaskState {
  switch (run.status) {
    case "succeeded":
      return "TASK_STATE_COMPLETED"
    case "failed":
      return "TASK_STATE_FAILED"
    case "cancelled":
      return "TASK_STATE_CANCELED"
    case "running":
      return (run.sessions?.length ?? 0) === 0 ? "TASK_STATE_SUBMITTED" : "TASK_STATE_WORKING"
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
  sessions?: readonly unknown[]
}

export function buildTask(input: {
  entry: A2aLedgerEntry
  run: A2aRunView
  artifacts?: A2aArtifact[]
  newId: () => string
}): A2aTask {
  const { entry, run } = input
  const state = mapRunState(run)
  const task: A2aTask = {
    id: entry.taskId,
    contextId: entry.contextId,
    status: {
      state,
      timestamp: run.endedAt ?? entry.createdAt,
      ...(state === "TASK_STATE_FAILED" && run.error
        ? {
            message: {
              messageId: input.newId(),
              role: "ROLE_AGENT" as const,
              parts: [{ text: run.error }],
              taskId: entry.taskId,
              contextId: entry.contextId,
            },
          }
        : {}),
    },
    metadata: { appId: entry.appId, skill: entry.skill },
  }
  if (state === "TASK_STATE_COMPLETED" && input.artifacts && input.artifacts.length > 0) {
    task.artifacts = input.artifacts
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
