// Ported daemon client type contract (standalone — mirrors, does NOT import,
// packages/vscode/src/client/types.ts). Reshaped only to honor this package's
// no-`unknown` rule: every `unknown` at the record boundary becomes `JsonValue`
// (the daemon's events.jsonl is JSON, so this is exact, not a widening).

/** Any JSON-serializable value — the shape of a daemon tool arg/result/option. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type SessionKind = "terminal" | "agent-cli" | "command" | "browser"
export type SessionStatus = "starting" | "running" | "exited" | "killed" | "error"

/** A browser tab the agent opened, read from the session descriptor + events. */
export interface BrowserTab {
  id: string
  url: string
  title: string
}

/**
 * SessionDescriptor — the daemon's canonical session row (GET /sessions).
 * A field-subset of the frozen client contract, carrying only what this shell
 * renders. Optional fields stay optional so partial daemon rows type-check.
 */
export interface SessionDescriptor {
  id: string
  kind: SessionKind
  workspaceSlug: string
  command: string
  status: SessionStatus
  startedAt?: string
  endedAt?: string
  exitCode?: number
  label?: string
  title?: string
  name?: string
  cwd?: string
  adapterSlug?: string
  model?: string
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  contextSize?: number
  contextUsed?: number
  awaitingInput?: boolean
  awaitingQuestion?: { text: string; options?: string[]; source: string }
  awaitingPermission?: boolean
  turnsCompleted?: number
  busy?: boolean
  blockedOn?: "subagent" | "command"
  pendingToolCallId?: string
  parentSessionId?: string
  depth?: number
  browserAdapterId?: string
  browserPort?: number
  browserBaseUrl?: string
  browserLocation?: "local" | "cloud"
}

export interface DaemonHealth {
  status?: string
  workspace?: string
  version?: string
  registered?: readonly string[]
  uptimeMs?: number
}

/**
 * One record from GET /sessions/:id/events — the daemon's durable, normalized
 * per-session semantic events. `arguments`/`result`/`options` are JSON values
 * (see JsonValue). An unknown `kind` is ignored by the reducer.
 */
export interface SessionEventRecord {
  seq: number
  ts: string
  kind: string
  sessionId?: string
  text?: string
  partial?: boolean
  toolCallId?: string
  toolName?: string
  arguments?: JsonValue
  isUpdate?: boolean
  result?: JsonValue
  isError?: boolean
  reason?: string
  error?: { message: string; code?: number; data?: JsonValue }
  options?: JsonValue
  entries?: Array<{ content: string; priority: string; status: string }>
  size?: number
  used?: number
  cost?: { amount: number; currency: string }
  tokensIn?: number
  tokensOut?: number
  model?: string
  costUsd?: number
  contextSize?: number
  contextUsed?: number
  source?: string
}

/** GET /sessions/:id/events response envelope. */
export interface SessionEventsPage {
  sessionId: string
  events: SessionEventRecord[]
  nextSeq: number
  complete: boolean
}

/** One changed file with its unified-diff lines, from the git_diff command. */
export type DiffLineKind = "hunk" | "add" | "del" | "ctx"

export interface DiffLine {
  kind: DiffLineKind
  /** Old-file line number (absent for adds / hunk headers). */
  oldLine?: number
  /** New-file line number (absent for dels / hunk headers). */
  newLine?: number
  text: string
}

export interface ChangedFile {
  /** Path relative to the repo root, e.g. "src/App.tsx". */
  path: string
  /** Just the basename, e.g. "App.tsx". */
  name: string
  /** Directory prefix incl. trailing slash, e.g. "src/". */
  dir: string
  added: number
  removed: number
  lines: DiffLine[]
}

/** git_diff command result — the working tree of a session's cwd. */
export interface GitDiff {
  branch: string
  added: number
  removed: number
  files: ChangedFile[]
  commits: Array<{ hash: string; message: string }>
}
