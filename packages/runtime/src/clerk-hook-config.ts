/**
 * `clerk` hook configuration — the AIP-68 "clerk pass" that runs after a
 * session's turn ends.
 *
 * ## WHAT THIS IS
 *
 * The clerk (AIP-68) is the daemon-side steward/secretary: when a session
 * finishes a turn, the daemon may — after an idle debounce — run ONE clerk
 * pass over that session's context. The pass is what the hook decides to
 * launch, and the hook is DISABLED by default: a daemon that never heard of
 * AIP-68 must not start running extra passes on its own.
 *
 * ## THREE LEVELS, MOST SPECIFIC WINS
 *
 * The resolved configuration is the merge of three levels, from the most
 * general to the most specific:
 *
 *   1. the DAEMON default (`~/.agentproto/config.json` → `daemon.clerk`),
 *      else the built-in default: `enabled:false`, a 10-minute debounce and
 *      the `steward` routine;
 *   2. the WORKSPACE level (`.agentproto/hooks.json` → `hooks.clerk`, the
 *      same file that already carries the semantic hook rules — see
 *      `hooks-config.ts`);
 *   3. the AGENT level (the agent's manifest, or an `agent_start` option) —
 *      the most specific, so it always wins.
 *
 * The merge is PER FIELD, not per object: an agent that only sets
 * `enabled:true` still inherits the workspace's `debounceMs` and `run`.
 * A field is only overridden when the more specific level actually states
 * it — an absent (or `null`) field never resets a less specific value.
 *
 * ## VOCABULARY (PR #2142)
 *
 * The field names follow the hook vocabulary of PR #2142: `hooks.enabled`
 * and `on: "turn_end"`. The workspace file may state the hook either
 * generically (under `hooks`) or namespaced (under `hooks.clerk`); the
 * namespaced one wins when both are present.
 *
 * ```json
 * {
 *   "hooks": {
 *     "clerk": {
 *       "enabled": true,
 *       "on": "turn_end",
 *       "debounceMs": 600000,
 *       "run": { "routine": "session-steward-hourly" },
 *       "exclude": ["sess_abc"]
 *     }
 *   }
 * }
 * ```
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"

import { z } from "zod"

/** The event a clerk hook can be bound to. v1: turn-end only — the pass is
 *  an AFTER-TURN reaction, and `on: "turn_end"` is the PR #2142 spelling. */
export const CLERK_HOOK_EVENTS = ["turn_end"] as const
export type ClerkHookEvent = (typeof CLERK_HOOK_EVENTS)[number]

/** What a clerk pass launches. Exactly one of `routine` / `command` is
 *  expected; `routine` names an AIP-41 routine (e.g. `"steward"`), `command`
 *  is a shell command run in the session's working directory. */
export interface ClerkHookRun {
  /** Routine id to trigger (AIP-41). The daemon's routine registrar fires
   *  it out-of-band, exactly like `cron_run` bypasses a job's schedule. */
  routine?: string
  /** Shell command to run instead of a routine. */
  command?: string
  /** argv for `command` (the command itself is argv[0]). */
  args?: string[]
  /** Working directory for `command`. Defaults to the session's cwd. */
  cwd?: string
  /** Hard cap on the pass's runtime (ms). The pass is fire-and-forget, but
   *  an unbounded child process would outlive the daemon's patience. */
  timeoutMs?: number
}

/** One clerk-hook configuration level (a partial view of the resolved
 *  configuration — every field optional). */
export interface ClerkHookConfig {
  /** Whether the hook fires at all. The built-in default is `false`. */
  enabled: boolean
  /** The event this hook is bound to. v1: `"turn_end"`. */
  on: ClerkHookEvent
  /** Idle debounce before the pass runs (ms). Default 10 minutes — the
   *  AIP-68 §3.6 idle-pause. */
  debounceMs: number
  /** What the pass launches. */
  run: ClerkHookRun
  /** Sessions this hook never touches — session ids, labels or agent ids. */
  exclude?: string[]
}

/** The built-in default: DISABLED, 10-minute debounce, `steward` routine. */
export const CLERK_HOOK_DEFAULT_DEBOUNCE_MS = 10 * 60_000

export const CLERK_HOOK_DEFAULTS: ClerkHookConfig = {
  enabled: false,
  on: "turn_end",
  debounceMs: CLERK_HOOK_DEFAULT_DEBOUNCE_MS,
  run: { routine: "steward" },
}

/** Where a resolved field came from — used for diagnostics and tests. */
export type ClerkHookSource = "default" | "daemon" | "workspace" | "agent"

export interface ResolvedClerkHookConfig {
  config: ClerkHookConfig
  /** Per-field provenance. */
  sources: Record<keyof ClerkHookConfig, ClerkHookSource>
}

/**
 * The `agent_start` input shape for one clerk hook level. Mirrors the
 * JSON a workspace's `.agentproto/hooks.json` may carry, so the same
 * object can be written in either place.
 */
export const clerkHookInputSchema = z.object({
  enabled: z.boolean().optional(),
  on: z.enum(CLERK_HOOK_EVENTS).optional(),
  debounceMs: z.number().int().nonnegative().optional(),
  run: z
    .object({
      routine: z.string().min(1).optional(),
      command: z.string().min(1).optional(),
      args: z.array(z.string()).optional(),
      cwd: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
  exclude: z.array(z.string().min(1)).optional(),
})

/** The `agent_start`'s `hooks` object — the agent level of the hook config.
 *  `hooks.clerk` is the clerk hook; a generic `hooks` object (the PR
 *  #2142 vocabulary: `hooks.enabled`, `on: "turn_end"`) is accepted too and
 *  applies to the clerk hook when no `hooks.clerk` is given. */
export const clerkHooksInputSchema = z.object({
  clerk: clerkHookInputSchema.optional(),
  enabled: z.boolean().optional(),
  on: z.enum(CLERK_HOOK_EVENTS).optional(),
  debounceMs: z.number().int().nonnegative().optional(),
})

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/** Parse ONE configuration level into a partial config. Tolerant: unknown
 *  keys are ignored, malformed values are dropped (never throw — a broken
 *  config file must not take the daemon down). */
export function parseClerkHookLevel(raw: unknown): Partial<ClerkHookConfig> {
  if (!isRecord(raw)) return {}
  const out: Partial<ClerkHookConfig> = {}
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled
  if (typeof raw.on === "string" && (CLERK_HOOK_EVENTS as readonly string[]).includes(raw.on)) {
    out.on = raw.on as ClerkHookEvent
  }
  if (typeof raw.debounceMs === "number" && Number.isFinite(raw.debounceMs) && raw.debounceMs >= 0) {
    out.debounceMs = raw.debounceMs
  }
  if (Array.isArray(raw.exclude)) {
    const list = raw.exclude.filter((x): x is string => typeof x === "string" && x.length > 0)
    if (list.length > 0) out.exclude = list
  }
  if (isRecord(raw.run)) {
    const r = raw.run
    const run: ClerkHookRun = {}
    if (typeof r.routine === "string" && r.routine.length > 0) run.routine = r.routine
    if (typeof r.command === "string" && r.command.length > 0) run.command = r.command
    if (Array.isArray(r.args)) {
      const args = r.args.filter((x): x is string => typeof x === "string")
      if (args.length > 0) run.args = args
    }
    if (typeof r.cwd === "string" && r.cwd.length > 0) run.cwd = r.cwd
    if (typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs) && r.timeoutMs > 0) {
      run.timeoutMs = r.timeoutMs
    }
    if (Object.keys(run).length > 0) out.run = run
  }
  return out
}

/** Merge two levels: `over` wins per field, but only for fields it
 *  actually states. `run` is merged FIELD BY FIELD too (an agent that only
 *  names a `routine` keeps the workspace's `timeoutMs`). */
export function mergeClerkHookLevels(
  base: ClerkHookConfig,
  over: Partial<ClerkHookConfig>,
): ClerkHookConfig {
  const merged: ClerkHookConfig = { ...base, run: { ...base.run } }
  if (over.enabled !== undefined) merged.enabled = over.enabled
  if (over.on !== undefined) merged.on = over.on
  if (over.debounceMs !== undefined) merged.debounceMs = over.debounceMs
  if (over.exclude !== undefined) merged.exclude = [...over.exclude]
  if (over.run !== undefined) merged.run = { ...merged.run, ...over.run }
  return merged
}

/**
 * Resolve the three levels into one configuration + per-field provenance.
 *
 * `daemon` / `workspace` / `agent` are the RAW values read from each
 * level (already the `hooks.clerk`-shaped object); the function is pure so
 * the precedence is testable without touching the filesystem.
 */
export function resolveClerkHookConfig(input: {
  daemon?: unknown
  workspace?: unknown
  agent?: unknown
}): ResolvedClerkHookConfig {
  const levels: Array<[ClerkHookSource, Partial<ClerkHookConfig>]> = [
    ["daemon", parseClerkHookLevel(input.daemon)],
    ["workspace", parseClerkHookLevel(input.workspace)],
    ["agent", parseClerkHookLevel(input.agent)],
  ]

  let config = mergeClerkHookLevels(CLERK_HOOK_DEFAULTS, {})
  const sources: Record<keyof ClerkHookConfig, ClerkHookSource> = {
    enabled: "default",
    on: "default",
    debounceMs: "default",
    run: "default",
    exclude: "default",
  }

  for (const [source, level] of levels) {
    if (level.enabled !== undefined) {
      config.enabled = level.enabled
      sources.enabled = source
    }
    if (level.on !== undefined) {
      config.on = level.on
      sources.on = source
    }
    if (level.debounceMs !== undefined) {
      config.debounceMs = level.debounceMs
      sources.debounceMs = source
    }
    if (level.run !== undefined) {
      config.run = { ...config.run, ...level.run }
      sources.run = source
    }
    if (level.exclude !== undefined) {
      config.exclude = [...level.exclude]
      sources.exclude = source
    }
  }

  return { config, sources }
}

const HOOKS_CONFIG_REL = ".agentproto/hooks.json"

/**
 * Read the WORKSPACE level out of `<workspace>/.agentproto/hooks.json`.
 *
 * The file is the semantic-hook file (`hooks-config.ts` reads its `rules`),
 * and it also carries the `hooks` section. Both the generic `hooks` object
 * and the namespaced `hooks.clerk` object are accepted (PR #2142's
 * vocabulary); the namespaced one wins. Missing file ⇒ no workspace level
 * (the daemon level applies). A malformed file is logged and ignored — the
 * hook simply stays at the less specific level.
 */
export function loadWorkspaceClerkHook(workspace: string): Partial<ClerkHookConfig> {
  const path = resolve(workspace, HOOKS_CONFIG_REL)
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
    if (!isRecord(raw)) return {}
    const hooks = raw.hooks
    if (!isRecord(hooks)) return {}
    const generic = parseClerkHookLevel(hooks)
    const named = isRecord(hooks.clerk) ? parseClerkHookLevel(hooks.clerk) : {}
    return mergePartialLevels(generic, named)
  } catch (err) {
    console.error(`[runtime] failed to read ${HOOKS_CONFIG_REL} (clerk hook ignored):`, err)
    return {}
  }
}

/** Merge two PARTIAL levels with the same per-field rule as
 *  {@link mergeClerkHookLevels}. */
function mergePartialLevels(
  base: Partial<ClerkHookConfig>,
  over: Partial<ClerkHookConfig>,
): Partial<ClerkHookConfig> {
  const merged: Partial<ClerkHookConfig> = { ...base }
  if (over.enabled !== undefined) merged.enabled = over.enabled
  if (over.on !== undefined) merged.on = over.on
  if (over.debounceMs !== undefined) merged.debounceMs = over.debounceMs
  if (over.exclude !== undefined) merged.exclude = [...over.exclude]
  if (over.run !== undefined) merged.run = { ...(merged.run ?? {}), ...over.run }
  return merged
}

/**
 * Read the DAEMON level out of `~/.agentproto/config.json`'s
 * `daemon.clerk` object. Tolerant of a missing file / a missing section.
 */
export function loadDaemonClerkHook(config: unknown): Partial<ClerkHookConfig> {
  if (!isRecord(config)) return {}
  const daemon = config.daemon
  if (!isRecord(daemon)) return {}
  return parseClerkHookLevel(daemon.clerk)
}

/**
 * The AGENT level, as read from an agent manifest's `metadata.hooks.clerk`
 * (the AIP-42 frontmatter has no free-form top-level key, `metadata` is the
 * namespaced home for daemon-specific settings) or from an `agent_start`
 * option's `hooks.clerk`.
 */
export function parseAgentClerkHook(raw: unknown): Partial<ClerkHookConfig> {
  if (!isRecord(raw)) return {}
  const hooks = raw.hooks
  if (!isRecord(hooks)) return {}
  const generic = parseClerkHookLevel(hooks)
  const named = isRecord(hooks.clerk) ? parseClerkHookLevel(hooks.clerk) : {}
  return mergePartialLevels(generic, named)
}

/** True when the file at `<workspace>/.agentproto/hooks.json` exists and
 *  carries a `hooks` section — used by diagnostics/tests. */
export function workspaceHasHooksFile(workspace: string): boolean {
  const path = resolve(workspace, HOOKS_CONFIG_REL)
  if (!existsSync(path)) return false
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}
