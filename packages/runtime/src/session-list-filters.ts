/**
 * Server-side narrowing for the session listers — the `session_list` MCP
 * tool and `GET /sessions` (+ `agentproto sessions --json`) share this one
 * module so the vocabulary and the semantics cannot drift between surfaces.
 *
 * Every filter is optional and AND-ed with the others. Vocabulary reuses
 * `session_follow`'s selector/exclude names (`rootOnly`, labels,
 * `parentSessionId`) rather than inventing a second one.
 *
 * Pure: no registry, no I/O, an injectable clock. The callers own subtree
 * scoping, archived/kind/status handling and pagination.
 */

import { z } from "zod"
import type { SessionDescriptor } from "./sessions.js"

/** Raised for caller-fixable filter input (an unparsable time bound). */
export class SessionListFilterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionListFilterError"
  }
}

/** A string or a list of strings. HTTP callers send `a,b` or repeat the key. */
export type StringOrList = string | readonly string[]

export interface SessionListFilterInput {
  /** Case-insensitive substring over id, name, label, title and cwd. */
  q?: string
  /** Only sessions whose `label` equals this (case-insensitive exact match). */
  label?: string
  /** Only sessions whose `cwd` is this path or lives under it (path prefix, boundary-aware). */
  cwd?: string
  /** Drop sessions whose `label` starts with any of these (case-sensitive). */
  excludeLabelPrefix?: StringOrList
  /** Drop sessions whose `label` equals any of these (as `session_follow`'s `exclude.labels`). */
  excludeLabels?: StringOrList
  /** Drop sessions of these kinds (`terminal` | `agent-cli` | `command`). */
  excludeKinds?: StringOrList
  /** Only sessions with no parent (as `session_follow`'s `selector.rootOnly`). */
  rootOnly?: boolean
  /** Only direct children of this session (the caller resolves a name to an id first). */
  parentSessionId?: string
  /** Only sessions whose last activity (else start) is at/after this: ISO-8601 or relative (`30m`, `24h`, `7d`, `2w`). */
  updatedSince?: string
  /** Only sessions started at/after this: ISO-8601 or relative. */
  startedSince?: string
  /** Preset: drop review lanes, workflow stages and ended one-shot command runs (see {@link isNoiseSession}). */
  excludeNoise?: boolean
}

/** Names of every filter key, for surfaces that parse them from a query string. */
export const SESSION_LIST_FILTER_KEYS = [
  "q",
  "label",
  "cwd",
  "excludeLabelPrefix",
  "excludeLabels",
  "excludeKinds",
  "rootOnly",
  "parentSessionId",
  "updatedSince",
  "startedSince",
  "excludeNoise",
] as const

/** Copy only the filter keys (a tool input carries many other params). */
export function pickSessionListFilters(input: SessionListFilterInput): SessionListFilterInput {
  const out: Record<string, unknown> = {}
  for (const key of SESSION_LIST_FILTER_KEYS) {
    if (input[key] !== undefined) out[key] = input[key]
  }
  return out as SessionListFilterInput
}

const TIME_UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const

const RELATIVE_RE = /^(\d+(?:\.\d+)?)\s*([smhdw])$/i

/**
 * Parse an ISO-8601 instant or a relative age (`90s`, `30m`, `24h`, `7d`,
 * `2w` = "that long before `now`") into epoch ms. Throws
 * {@link SessionListFilterError} on anything else.
 */
export function parseTimeBound(raw: string, field: string, now: number = Date.now()): number {
  const text = raw.trim()
  const rel = RELATIVE_RE.exec(text)
  if (rel) {
    const n = Number(rel[1])
    const unit = TIME_UNIT_MS[rel[2]!.toLowerCase() as keyof typeof TIME_UNIT_MS]
    return now - n * unit
  }
  const abs = text === "" ? Number.NaN : Date.parse(text)
  if (Number.isNaN(abs)) {
    throw new SessionListFilterError(
      `${field} must be an ISO-8601 time or a relative age like "30m", "24h", "7d", "2w"; got ${JSON.stringify(raw)}.`,
    )
  }
  return abs
}

function toList(v: StringOrList | undefined): string[] {
  if (v === undefined) return []
  const parts = typeof v === "string" ? [v] : [...v]
  return parts.flatMap(p => p.split(",")).map(s => s.trim()).filter(s => s.length > 0)
}

const REVIEW_LABEL_PREFIX = "review:"
const WORKFLOW_LABEL_PREFIX = "wf:"
const NOISE_ORIGINS: ReadonlySet<string> = new Set(["review", "workflow"])

type NoiseView = Pick<SessionDescriptor, "kind" | "status" | "label" | "origin" | "adapterSlug">

/**
 * What `excludeNoise: true` drops — exactly these, nothing else:
 *  1. review lanes: `label` starts with `review:` or `origin === "review"`;
 *  2. workflow stage sessions: `label` starts with `wf:` or `origin === "workflow"`;
 *  3. ended one-shot command runs: `status` is `exited` or `killed` and the
 *     session is a plain command — `kind: "command"`, or `kind: "terminal"`
 *     with no `adapterSlug` (an interactive agent TUI such as `claude` carries
 *     one, so it is kept).
 * A live session of kind 3 (a running dev server, a `bash` you are typing in)
 * and every agent-cli session outside 1–2 are kept, as is anything `error`ed.
 */
export function isNoiseSession(s: NoiseView): boolean {
  if (isReviewOrWorkflowSession(s)) return true
  // Inbox-only rows (Desktop / CLI sessions the daemon doesn't run) are not agents.
  if (s.kind === "external") return true
  const ended = s.status === "exited" || s.status === "killed"
  if (ended && (s.kind === "command" || (s.kind === "terminal" && !s.adapterSlug))) return true
  return false
}

/**
 * Just the review-lane / workflow-stage lanes of {@link isNoiseSession}
 * (steps 1–2): `label` starts with `review:` or `wf:`, or `origin` is
 * `review` / `workflow`. Used to group these under one synthetic parent node
 * without also swallowing ended one-shot command runs.
 */
export function isReviewOrWorkflowSession(s: Pick<NoiseView, "label" | "origin">): boolean {
  const label = s.label ?? ""
  if (label.startsWith(REVIEW_LABEL_PREFIX) || label.startsWith(WORKFLOW_LABEL_PREFIX)) return true
  return s.origin !== undefined && NOISE_ORIGINS.has(s.origin)
}

/** Epoch ms of a session's last activity, falling back to its start. */
export function sessionActivityMs(s: Pick<SessionDescriptor, "lastActivityAt" | "startedAt">): number {
  const ms = Date.parse(s.lastActivityAt ?? s.startedAt)
  return Number.isNaN(ms) ? 0 : ms
}

/** Newest activity first; ties broken by id so cursors stay stable. Returns a new array. */
export function sortNewestActivityFirst<T extends Pick<SessionDescriptor, "id" | "lastActivityAt" | "startedAt">>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => sessionActivityMs(b) - sessionActivityMs(a) || a.id.localeCompare(b.id))
}

/** True when `input` carries at least one filter (an empty `q` / `false` flag does not count). */
export function hasSessionListFilters(input: SessionListFilterInput): boolean {
  return (
    (input.q !== undefined && input.q.trim() !== "") ||
    (input.label !== undefined && input.label.trim() !== "") ||
    (input.cwd !== undefined && input.cwd.trim() !== "") ||
    toList(input.excludeLabelPrefix).length > 0 ||
    toList(input.excludeLabels).length > 0 ||
    toList(input.excludeKinds).length > 0 ||
    input.rootOnly === true ||
    (input.parentSessionId !== undefined && input.parentSessionId !== "") ||
    (input.updatedSince !== undefined && input.updatedSince.trim() !== "") ||
    (input.startedSince !== undefined && input.startedSince.trim() !== "") ||
    input.excludeNoise === true
  )
}

type FilterableSession = Pick<
  SessionDescriptor,
  | "id"
  | "kind"
  | "status"
  | "name"
  | "label"
  | "title"
  | "cwd"
  | "origin"
  | "adapterSlug"
  | "parentSessionId"
  | "lastActivityAt"
  | "startedAt"
>

/**
 * Trim trailing slashes from a directory prefix, collapsing the empty root
 * (`/` → `""`), so `pathUnder` can compare with a single boundary-aware rule.
 */
function normalizePathPrefix(raw: string): string {
  const trimmed = raw.trim()
  const collapsed = trimmed.replace(/\/{2,}/g, "/")
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed
}

/** True when `p` equals `root` or lives under it (`/a/b` under `/a`, not under `/ab`). */
function pathUnder(p: string | undefined, root: string): boolean {
  if (p === undefined || p === "") return false
  if (root === "") return p.startsWith("/")
  if (p === root) return true
  return p.startsWith(root.endsWith("/") ? root : `${root}/`)
}

/**
 * Compile `input` into a row predicate. Validates (and resolves relative
 * times against `now`) once, up front, so a bad `updatedSince` fails the
 * whole call instead of silently matching nothing.
 */
export function compileSessionListFilters(
  input: SessionListFilterInput,
  now: number = Date.now(),
): (s: FilterableSession) => boolean {
  const q = input.q?.trim().toLowerCase() ?? ""
  const labelExact = input.label && input.label.trim() !== "" ? input.label.trim().toLowerCase() : undefined
  const cwdRoot =
    input.cwd && input.cwd.trim() !== "" ? normalizePathPrefix(input.cwd.trim()) : undefined
  const prefixes = toList(input.excludeLabelPrefix)
  const labels = new Set(toList(input.excludeLabels))
  const kinds = new Set(toList(input.excludeKinds))
  const parentId = input.parentSessionId && input.parentSessionId !== "" ? input.parentSessionId : undefined
  const updatedSince =
    input.updatedSince && input.updatedSince.trim() !== ""
      ? parseTimeBound(input.updatedSince, "updatedSince", now)
      : undefined
  const startedSince =
    input.startedSince && input.startedSince.trim() !== ""
      ? parseTimeBound(input.startedSince, "startedSince", now)
      : undefined

  return s => {
    if (q) {
      const hit = [s.id, s.name, s.label, s.title, s.cwd].some(f => f !== undefined && f.toLowerCase().includes(q))
      if (!hit) return false
    }
    if (kinds.has(s.kind)) return false
    const label = s.label
    if (labelExact !== undefined && (label ?? "").toLowerCase() !== labelExact) return false
    if (cwdRoot !== undefined && !pathUnder(s.cwd, cwdRoot)) return false
    if (label !== undefined) {
      if (labels.has(label)) return false
      if (prefixes.some(p => label.startsWith(p))) return false
    }
    if (input.rootOnly === true && s.parentSessionId) return false
    if (parentId !== undefined && s.parentSessionId !== parentId) return false
    if (updatedSince !== undefined && sessionActivityMs(s) < updatedSince) return false
    if (startedSince !== undefined) {
      const started = Date.parse(s.startedAt)
      if (Number.isNaN(started) || started < startedSince) return false
    }
    if (input.excludeNoise === true && isNoiseSession(s)) return false
    return true
  }
}

/** Filter `rows` (order preserved). Throws {@link SessionListFilterError} on a bad time bound. */
export function applySessionListFilters<T extends FilterableSession>(
  rows: readonly T[],
  input: SessionListFilterInput,
  now: number = Date.now(),
): T[] {
  if (!hasSessionListFilters(input)) return [...rows]
  return rows.filter(compileSessionListFilters(input, now))
}

/**
 * Read the filters off an HTTP query string. Array-valued keys accept
 * `a,b` or a repeated key; booleans accept `true`/`1` (anything else is off).
 */
export function parseSessionListFilterParams(params: URLSearchParams): SessionListFilterInput {
  const flag = (k: string): boolean | undefined => {
    const v = params.get(k)
    return v === null ? undefined : v === "true" || v === "1"
  }
  const list = (k: string): string[] | undefined => {
    const all = params.getAll(k)
    return all.length > 0 ? toList(all) : undefined
  }
  const str = (k: string): string | undefined => {
    const v = params.get(k)
    return v === null || v === "" ? undefined : v
  }
  const out: SessionListFilterInput = {}
  const q = str("q")
  if (q !== undefined) out.q = q
  const label = str("label")
  if (label !== undefined) out.label = label
  const cwd = str("cwd")
  if (cwd !== undefined) out.cwd = cwd
  const prefix = list("excludeLabelPrefix")
  if (prefix) out.excludeLabelPrefix = prefix
  const labels = list("excludeLabels")
  if (labels) out.excludeLabels = labels
  const kinds = list("excludeKinds")
  if (kinds) out.excludeKinds = kinds
  const rootOnly = flag("rootOnly")
  if (rootOnly !== undefined) out.rootOnly = rootOnly
  const parent = str("parentSessionId")
  if (parent !== undefined) out.parentSessionId = parent
  const updatedSince = str("updatedSince")
  if (updatedSince !== undefined) out.updatedSince = updatedSince
  const startedSince = str("startedSince")
  if (startedSince !== undefined) out.startedSince = startedSince
  const noise = flag("excludeNoise")
  if (noise !== undefined) out.excludeNoise = noise
  return out
}

const mcpBool = z.preprocess(v => (v === "true" ? true : v === "false" ? false : v), z.boolean())
const stringOrList = z.union([z.string(), z.array(z.string())])

/** Zod fragment spread into `session_list`'s input schema. */
export const sessionListFilterShape = {
  q: z.string().optional().describe("Case-insensitive substring over id, name, label, title, cwd."),
  label: z.string().optional().describe("Only sessions whose label equals this (case-insensitive)."),
  cwd: z.string().optional().describe("Only sessions whose cwd is this path or a path under it."),
  excludeLabelPrefix: stringOrList.optional().describe("Drop labels starting with any of these, e.g. ['review:','wf:']."),
  excludeLabels: stringOrList.optional().describe("Drop labels exactly equal to any of these (as session_follow exclude.labels)."),
  excludeKinds: stringOrList.optional().describe("Drop kinds: terminal | agent-cli | command."),
  rootOnly: mcpBool.optional().describe("Only sessions with no parent."),
  parentSessionId: z.string().optional().describe("Only direct children of this session (id or name)."),
  updatedSince: z.string().optional().describe("Activity at/after: ISO time or age like '30m','24h','7d'."),
  startedSince: z.string().optional().describe("Started at/after: ISO time or age like '30m','24h','7d'."),
  excludeNoise: mcpBool
    .optional()
    .describe(
      "Drop review:*/wf:* sessions and ended command/plain-terminal runs. Details: tool_help {name:\"session_list\", topic:\"excludeNoise\"}",
    ),
} as const
