/**
 * `.agentproto/hooks.json` schema + loader for the semantic hook engine
 * (Plane 1) — the rule table `decide()` consults at the pre-exec permission
 * seam (the "agent-prompt" handler in sessions.ts, which used to check only
 * the per-session `permissionHold` boolean). Mirrors the
 * `allowed-commands.json` loader in command-tools.ts: cheap `stat`, mtime-
 * keyed cache, quiet default when the file is absent.
 *
 * ## LOG-ONLY BY DEFAULT
 *
 * A missing file, or a file whose rules are all `action:"log"`, changes
 * NOTHING about the pre-exec decision: `decide()` falls through to its
 * `fallback` argument (today's `permissionHold`-boolean-derived value)
 * exactly as before this engine existed. A `"log"` rule only tags a match
 * for future observability (see PR 3's `tool_calls_list`) — it never
 * overrides the decision. An operator opts into enforcement explicitly by
 * writing a rule with `action:"hold"`, `"deny"`, or `"gate"` into their own
 * `.agentproto/hooks.json` (workspace-local, gitignored — never shipped by
 * this repo).
 *
 * ## THE `"gate"` ACTION
 *
 * `action:"gate"` runs a shell command (`HookRule.gate`, required for this
 * action) when the rule matches, and resolves the held permission request
 * from its exit code — 0 → approve, non-zero (or an allowlist miss / exec
 * exception) → deny. This is the first real ENFORCING action the engine
 * ships (`"hold"`/`"deny"` degrade to the same human-hold path today — see
 * `sessions.ts`). It reuses `runShellGate` from `supervisor.ts` — the same
 * allowlist check, cwd-anchor, and timeout the completion-policy
 * supervisor's turn-end gate already uses — so a hook-engine gate behaves
 * identically to a policy gate rather than being a second implementation.
 * The canonical first use is gating an agent's own `git push`:
 *
 * ```json
 * {
 *   "id": "git-push-review-gate",
 *   "plane": "semantic",
 *   "match": { "tool": "Bash", "command": "^git push" },
 *   "action": "gate",
 *   "gate": { "command": "pnpm", "args": ["test"] }
 * }
 * ```
 *
 * ## Two planes, one config, an explicit tag
 *
 * Every rule declares `plane: "semantic" | "blast-radius"`. Plane 1
 * ("semantic") is this ACP permission seam — soft, bypassable in bypass
 * posture, blind to 3/10 non-ACP harnesses. Plane 2 ("blast-radius") is the
 * OS-level sandbox (`command-sandbox.ts`) — unbypassable once wired at the
 * process boundary. `decide()` only ever consults `"semantic"` rules,
 * because that's the only plane this seam can enforce; a `"blast-radius"`
 * rule is recorded here (so the config is one file) but has no effect until
 * a later PR wires the session-level OS-sandbox provider.
 *
 * ## RISK-0 GUARD
 *
 * A rule tagged `intent:"security"` cannot compile to a `plane:"semantic"`
 * rule whose action is `"hold"`, `"deny"`, or `"gate"` — that combination is
 * a false sense of safety: a Plane-1 hold/deny/gate never fires in bypass
 * posture, is invisible to in-process tools, and doesn't exist for the 3
 * opaque harnesses. Security intent must be expressed as
 * `plane:"blast-radius"` instead. `parseHooksConfig`/`validateHookRule`
 * throw a `HooksConfigError` for this at load time rather than silently
 * under-enforcing it.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"

const HOOKS_CONFIG_REL = ".agentproto/hooks.json"

export type HookPlane = "semantic" | "blast-radius"
export type HookIntent = "workflow" | "security"
/** `"log"` never changes the pre-exec decision — see module docblock. */
export type HookAction = "log" | "allow" | "hold" | "deny" | "gate"
export type HookDecision = "allow" | "hold" | "deny" | "gate"

export interface HookRuleMatch {
  /** Exact tool name ("Bash", "command_execute", …). Omitted or `"*"` matches any tool. */
  tool?: string
  /** Regex SOURCE (not a `RegExp`) tested against the shell command string. */
  command?: string
  /** Regex sources tested positionally against argv — `argv[i]` tests `args[i]`. */
  argv?: string[]
  /** Glob tested against every argv entry; matches if any entry matches. */
  pathGlob?: string
}

/**
 * Shell command run by an `action:"gate"` rule — structurally identical to
 * `supervisor.ts`'s `ShellGateSpec` (no import from there: this is a JSON
 * config schema and stays free of runtime-module coupling; the shapes are
 * kept in sync by convention and by `runShellGate` accepting either).
 */
export interface HookGateSpec {
  command: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
}

export interface HookRule {
  id: string
  /** Which enforcement plane this rule needs — see module docblock. */
  plane: HookPlane
  /** Declared intent. Required for the RISK-0 GUARD to fire; omit for
   *  ordinary workflow rules (the guard only inspects `"security"`). */
  intent?: HookIntent
  match: HookRuleMatch
  action: HookAction
  /** Required when `action === "gate"`; ignored otherwise. */
  gate?: HookGateSpec
}

interface HooksConfigFile {
  version?: number
  rules?: unknown
}

/** Thrown at load time for a malformed rule or a RISK-0 GUARD violation.
 *  Never silently downgraded to "no rules" inside `parseHooksConfig` — the
 *  loader (`loadHooksConfig`) is what decides how to degrade, and does so
 *  loudly (`console.error`), not silently. */
export class HooksConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HooksConfigError"
  }
}

function validateHookRule(rule: unknown, index: number): HookRule {
  if (!rule || typeof rule !== "object") {
    throw new HooksConfigError(`hooks.json rules[${index}] must be an object`)
  }
  const r = rule as Record<string, unknown>
  const id = typeof r.id === "string" && r.id.length > 0 ? r.id : `rules[${index}]`

  if (r.plane !== "semantic" && r.plane !== "blast-radius") {
    throw new HooksConfigError(
      `hooks.json rule "${id}" must set plane:"semantic" or plane:"blast-radius" ` +
        `(got ${JSON.stringify(r.plane)}) — every rule must declare which enforcement plane it needs.`,
    )
  }
  const plane = r.plane

  if (r.intent !== undefined && r.intent !== "workflow" && r.intent !== "security") {
    throw new HooksConfigError(
      `hooks.json rule "${id}" has invalid intent ${JSON.stringify(r.intent)} ` +
        `(expected "workflow" or "security")`,
    )
  }
  const intent = r.intent as HookIntent | undefined

  if (
    r.action !== "log" &&
    r.action !== "allow" &&
    r.action !== "hold" &&
    r.action !== "deny" &&
    r.action !== "gate"
  ) {
    throw new HooksConfigError(
      `hooks.json rule "${id}" has invalid action ${JSON.stringify(r.action)} ` +
        `(expected "log" | "allow" | "hold" | "deny" | "gate")`,
    )
  }
  const action = r.action

  // RISK-0 GUARD — see module docblock.
  if (
    intent === "security" &&
    plane === "semantic" &&
    (action === "hold" || action === "deny" || action === "gate")
  ) {
    throw new HooksConfigError(
      `hooks.json rule "${id}" declares intent:"security" with plane:"semantic" and action:${JSON.stringify(action)} — ` +
        `refusing to load. A Plane-1 (ACP permission-seam) hold/deny/gate is bypassable: it never fires in bypass ` +
        `posture, is invisible to in-process tools, and doesn't exist for non-ACP harnesses. That makes it a false ` +
        `sense of safety for a security rule. Use plane:"blast-radius" (the OS sandbox) for security intent instead.`,
    )
  }

  let gate: HookGateSpec | undefined
  const gateRaw = r.gate
  if (action === "gate") {
    if (
      !gateRaw ||
      typeof gateRaw !== "object" ||
      typeof (gateRaw as Record<string, unknown>).command !== "string" ||
      (gateRaw as Record<string, unknown>).command === ""
    ) {
      throw new HooksConfigError(
        `hooks.json rule "${id}" has action:"gate" but no valid gate.command ` +
          `(a non-empty string is required)`,
      )
    }
    const g = gateRaw as Record<string, unknown>
    gate = { command: g.command as string }
    if (Array.isArray(g.args) && g.args.every(x => typeof x === "string")) {
      gate.args = g.args as string[]
    }
    if (typeof g.cwd === "string") gate.cwd = g.cwd
    if (typeof g.timeoutMs === "number") gate.timeoutMs = g.timeoutMs
  } else if (gateRaw !== undefined) {
    throw new HooksConfigError(
      `hooks.json rule "${id}" sets "gate" but action is ${JSON.stringify(action)} ` +
        `— "gate" is only valid with action:"gate"`,
    )
  }

  const matchRaw = r.match
  const match: HookRuleMatch = {}
  if (matchRaw && typeof matchRaw === "object") {
    const m = matchRaw as Record<string, unknown>
    if (typeof m.tool === "string") match.tool = m.tool
    if (typeof m.command === "string") match.command = m.command
    if (Array.isArray(m.argv) && m.argv.every(x => typeof x === "string")) {
      match.argv = m.argv as string[]
    }
    if (typeof m.pathGlob === "string") match.pathGlob = m.pathGlob
  }

  return { id, plane, ...(intent ? { intent } : {}), match, action, ...(gate ? { gate } : {}) }
}

/** Parse + validate a raw `hooks.json` string. Throws `HooksConfigError` (or
 *  a `SyntaxError` for bad JSON) rather than returning a partial result —
 *  callers decide how to degrade (see `loadHooksConfig`). */
export function parseHooksConfig(raw: string): HookRule[] {
  const parsed = JSON.parse(raw) as HooksConfigFile
  const rulesRaw = Array.isArray(parsed.rules) ? parsed.rules : []
  return rulesRaw.map((rule, index) => validateHookRule(rule, index))
}

interface HooksConfigCacheEntry {
  mtimeMs: number
  rules: HookRule[]
}

let hooksConfigCache: { path: string; entry: HooksConfigCacheEntry } | null = null

/**
 * Load `<workspace>/.agentproto/hooks.json`, cached by mtime (cheap `stat`
 * per call, matching `loadAllowlist`'s pattern). Missing file ⇒ no rules
 * (log-only default — see module docblock). Synchronous because the only
 * call site, the "agent-prompt" pre-exec seam in sessions.ts, is itself
 * synchronous (sessions.ts already uses sync fs for similarly small,
 * frequently-re-read config, e.g. `readRegisteredSlugs`).
 *
 * A malformed file or a RISK-0 GUARD violation is logged loudly and
 * degrades to "no rules" (NOT a crash) — same fail-safe posture as
 * `loadAllowlist`'s bad-JSON handling, so one broken hooks.json can't take
 * the daemon down. The rules that would have applied simply don't, which
 * is safe by construction: it can only ever fall back toward the
 * pre-existing `permissionHold` behavior, never invent a new denial.
 */
export function loadHooksConfig(workspace: string): HookRule[] {
  const path = resolve(workspace, HOOKS_CONFIG_REL)
  if (!existsSync(path)) {
    hooksConfigCache = null
    return []
  }
  try {
    const s = statSync(path)
    if (
      hooksConfigCache &&
      hooksConfigCache.path === path &&
      hooksConfigCache.entry.mtimeMs === s.mtimeMs
    ) {
      return hooksConfigCache.entry.rules
    }
    const raw = readFileSync(path, "utf8")
    const rules = parseHooksConfig(raw)
    hooksConfigCache = { path, entry: { mtimeMs: s.mtimeMs, rules } }
    return rules
  } catch (err) {
    console.error(
      `[runtime] failed to load ${HOOKS_CONFIG_REL} (no rules will apply):`,
      err,
    )
    hooksConfigCache = null
    return []
  }
}

export interface HookDecideInput {
  tool: string
  command?: string
  args?: string[]
}

function testRegex(source: string, value: string): boolean {
  try {
    return new RegExp(source).test(value)
  } catch {
    return false
  }
}

/** Minimal glob → RegExp: `*` matches within a path segment, `**` matches
 *  across segments, `?` matches one character. Anchored full-string match. */
function globToRegExp(glob: string): RegExp {
  const placeholder = " DOUBLESTAR "
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, placeholder)
    .replace(/\*/g, "[^/]*")
    .split(placeholder)
    .join(".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`)
}

function matchesRule(match: HookRuleMatch, input: HookDecideInput): boolean {
  if (match.tool && match.tool !== "*" && match.tool !== input.tool) return false
  if (match.command !== undefined) {
    if (input.command === undefined || !testRegex(match.command, input.command)) return false
  }
  if (match.argv && match.argv.length > 0) {
    const args = input.args ?? []
    for (let i = 0; i < match.argv.length; i++) {
      const pattern = match.argv[i]
      const value = args[i]
      if (pattern === undefined || value === undefined || !testRegex(pattern, value)) return false
    }
  }
  if (match.pathGlob !== undefined) {
    const args = input.args ?? []
    const re = globToRegExp(match.pathGlob)
    if (!args.some(a => re.test(a))) return false
  }
  return true
}

/**
 * Evaluate the rule table at the pre-exec (Plane-1) seam and return both the
 * decision and the rule that produced it. The first matching non-`"log"`
 * rule wins; `"log"` rules tag a match for observability but never change
 * the decision (LOG-ONLY DEFAULT — see module docblock). No match at all
 * (including the empty rule set) falls through to `fallback` with no rule.
 *
 * Only `plane:"semantic"` rules are considered — a `"blast-radius"` rule
 * needs the OS sandbox (Plane 2), which this seam doesn't enforce.
 *
 * Callers pass `fallback` as `rt.permissionHold ? "hold" : "allow"`, so an
 * empty or log-only rule set reproduces today's behavior exactly. Exported
 * (rather than folded into `decide()`) because the `action:"gate"` caller
 * (`sessions.ts`'s `agent-prompt` handler) needs the matched rule's
 * `gate` spec to actually run the shell command — `decide()` alone, which
 * only ever returned the decision string, can't express that.
 */
export function decideRule(
  rules: readonly HookRule[],
  input: HookDecideInput,
  fallback: "allow" | "hold",
): { decision: HookDecision; rule?: HookRule } {
  for (const rule of rules) {
    if (rule.plane !== "semantic") continue
    if (rule.action === "log") continue
    if (matchesRule(rule.match, input)) return { decision: rule.action, rule }
  }
  return { decision: fallback }
}

/** Thin wrapper over `decideRule()` for callers that only need the decision
 *  string, not the matched rule (e.g. tests, and any future non-gate
 *  caller). See `decideRule()` for the full contract. */
export function decide(
  rules: readonly HookRule[],
  input: HookDecideInput,
  fallback: "allow" | "hold",
): HookDecision {
  return decideRule(rules, input, fallback).decision
}
