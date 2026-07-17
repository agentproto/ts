/**
 * Rule matching for `agentproto permissions watch` — the declarative side of
 * the auto-resolver, kept pure (no I/O, no daemon types) so it unit-tests
 * without mocks and can't grow into a policy engine by accident.
 *
 * A rule maps a match (tool-name pattern and/or session id/label) to a
 * decision (`approve`/`deny`) plus optional `optionId`/`scope` forwarded to
 * `POST /permissions/:id` verbatim. First matching rule wins; no rule means
 * the request is left parked — the watcher never invents a default.
 *
 * Pattern syntax is deliberately tiny: an exact tool name, or `*` as a
 * wildcard (`mcp__*`). No regex, no `?`, no character classes. An entry with
 * no `toolName` at all never matches a tool pattern — even `*` — so the only
 * way to auto-resolve a nameless request is an explicit session-only rule
 * from `--rules-json`.
 */

/** The slice of a `GET /permissions` entry the matcher looks at. Kept local
 *  (not imported from permissions.ts) to avoid a module cycle. */
export interface MatchableEntry {
  id: string
  sessionId: string
  sessionLabel?: string
  toolName?: string
}

export interface PermissionRule {
  /** At least one of toolName/sessionId. toolName is an exact name or a
   *  `*`-glob; sessionId matches the entry's sessionId OR sessionLabel,
   *  exact. */
  match: { toolName?: string; sessionId?: string }
  decision: "approve" | "deny"
  /** Forwarded verbatim; omitted → the daemon's decision→option mapping
   *  picks (approve → allow-flavored, deny → reject-flavored). */
  optionId?: string
  /** Approve only. `always` prefers the agent's allow-always option. */
  scope?: "once" | "always"
}

export interface CompiledRule extends PermissionRule {
  /** null = no toolName constraint (session-only rule). */
  toolNameRe: RegExp | null
  /** Position in the rule list, for audit lines (1-based in output). */
  index: number
}

/** Compile an exact-or-`*`-glob tool pattern to an anchored, case-sensitive
 *  RegExp. Everything except `*` is matched literally. */
export function compileToolPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${escaped.replace(/\\\*/g, ".*")}$`)
}

function compile(rule: PermissionRule, index: number): CompiledRule {
  return {
    ...rule,
    toolNameRe: rule.match.toolName !== undefined ? compileToolPattern(rule.match.toolName) : null,
    index,
  }
}

/** Build rules from the `watch` flags. Deny rules come FIRST — `parseArgs`
 *  loses interleave order across repeated flags, so instead of pretending to
 *  honour "order given" we fix the conservative order; `--rules-json` is the
 *  escape hatch for explicit ordering. */
export function compileRulesFromFlags(opts: {
  allow: readonly string[]
  deny: readonly string[]
  session?: string
  always?: boolean
}): CompiledRule[] {
  const sessionId = opts.session
  const rules: PermissionRule[] = [
    ...opts.deny.map(pattern => ({
      match: { toolName: pattern, ...(sessionId ? { sessionId } : {}) },
      decision: "deny" as const,
    })),
    ...opts.allow.map(pattern => ({
      match: { toolName: pattern, ...(sessionId ? { sessionId } : {}) },
      decision: "approve" as const,
      ...(opts.always ? { scope: "always" as const } : {}),
    })),
  ]
  return rules.map(compile)
}

/** Validate a parsed `--rules-json` value into compiled rules. Strict: any
 *  unrecognised shape is an error with a message specific enough to fix the
 *  JSON, not a silent no-match. */
export function parseRulesJson(
  parsed: unknown,
): { ok: true; rules: CompiledRule[] } | { ok: false; error: string } {
  if (!Array.isArray(parsed)) {
    return { ok: false, error: "--rules-json must be a JSON array of rule objects" }
  }
  if (parsed.length === 0) {
    return { ok: false, error: "--rules-json must contain at least one rule" }
  }
  const rules: PermissionRule[] = []
  for (let i = 0; i < parsed.length; i++) {
    const at = `rule ${i + 1}`
    const raw = parsed[i]
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `${at}: must be an object` }
    }
    const r = raw as Record<string, unknown>
    if (r.decision !== "approve" && r.decision !== "deny") {
      return { ok: false, error: `${at}: decision must be "approve" or "deny"` }
    }
    const rawMatch = r.match
    if (!rawMatch || typeof rawMatch !== "object" || Array.isArray(rawMatch)) {
      return { ok: false, error: `${at}: match must be an object` }
    }
    const m = rawMatch as Record<string, unknown>
    if (m.toolName !== undefined && typeof m.toolName !== "string") {
      return { ok: false, error: `${at}: match.toolName must be a string` }
    }
    if (m.sessionId !== undefined && typeof m.sessionId !== "string") {
      return { ok: false, error: `${at}: match.sessionId must be a string` }
    }
    if (m.toolName === undefined && m.sessionId === undefined) {
      return {
        ok: false,
        error: `${at}: match needs at least one of toolName/sessionId`,
      }
    }
    if (r.optionId !== undefined && typeof r.optionId !== "string") {
      return { ok: false, error: `${at}: optionId must be a string` }
    }
    if (r.scope !== undefined && r.scope !== "once" && r.scope !== "always") {
      return { ok: false, error: `${at}: scope must be "once" or "always"` }
    }
    if (r.scope !== undefined && r.decision !== "approve") {
      return { ok: false, error: `${at}: scope only applies to approve rules` }
    }
    rules.push({
      match: {
        ...(m.toolName !== undefined ? { toolName: m.toolName } : {}),
        ...(m.sessionId !== undefined ? { sessionId: m.sessionId } : {}),
      },
      decision: r.decision,
      ...(r.optionId !== undefined ? { optionId: r.optionId as string } : {}),
      ...(r.scope !== undefined ? { scope: r.scope } : {}),
    })
  }
  return { ok: true, rules: rules.map(compile) }
}

/** First matching rule, or null → leave the request parked. */
export function matchEntry(
  rules: readonly CompiledRule[],
  entry: MatchableEntry,
): CompiledRule | null {
  for (const rule of rules) {
    if (rule.match.sessionId !== undefined) {
      const s = rule.match.sessionId
      if (s !== entry.sessionId && s !== entry.sessionLabel) continue
    }
    if (rule.toolNameRe !== null) {
      // A nameless request never matches a tool pattern — even `*`. Only an
      // explicit session-only rule may auto-resolve it.
      if (entry.toolName === undefined) continue
      if (!rule.toolNameRe.test(entry.toolName)) continue
    }
    return rule
  }
  return null
}

/** Short audit-line label, e.g. `rule 2: deny Bash @ s-abc`. */
export function describeRule(rule: CompiledRule): string {
  const tool = rule.match.toolName ?? "(any tool)"
  const at = rule.match.sessionId ? ` @ ${rule.match.sessionId}` : ""
  return `rule ${rule.index + 1}: ${rule.decision} ${tool}${at}`
}
