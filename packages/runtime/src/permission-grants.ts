/**
 * `defaults.permissionGrants` — extra Claude Code permission ALLOW rules for
 * sessions spawned with a given label, written into that session's isolated
 * `settings.json` (`permissions.allow`) at every spawn, restart and resume.
 *
 * It exists for one narrow need: the host-guard escalation session
 * (`host-guard-escalation`) must be able to run `agentproto host stop-process`
 * when a session's process saturates the host, without a permission prompt
 * that nobody is there to answer and that the harness's own auto-mode
 * classifier refuses. The grant is the command, not the act: the daemon
 * still decides what that command may stop (only a descendant of a live
 * session; see host-stop-process.ts), so the rule widens nothing beyond it.
 *
 * The default below is the whole policy, in code, reviewed with the code.
 * An operator who sets `defaults.permissionGrants` replaces it entirely
 * (`{}` turns every grant off). The key is operator-only: an agent's
 * `config_set` cannot write it.
 */

import type { SpawnDefaultsConfig } from "./spawn-defaults.js"

/** Label of the session `agentproto host guard` spawns to escalate. */
export const HOST_GUARD_ESCALATION_LABEL = "host-guard-escalation"

/** The one rule the escalation session needs: `agentproto host stop-process`
 *  with any arguments (Claude Code prefix rule). */
export const HOST_STOP_PROCESS_RULE = "Bash(agentproto host stop-process:*)"

export const DEFAULT_PERMISSION_GRANTS: Readonly<Record<string, readonly string[]>> = {
  [HOST_GUARD_ESCALATION_LABEL]: [HOST_STOP_PROCESS_RULE],
}

/** Adapters whose isolated settings carry `permissions.allow`. */
const GRANT_ADAPTERS = new Set(["claude-code"])

/** One accepted rule: a single-line permission rule, `Tool` or `Tool(spec)`. */
export const PERMISSION_RULE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\([^\n\r]{1,200}\))?$/

/**
 * The allow rules to hand `startSession({ permissionAllow })`, or undefined
 * when none apply: no label, an adapter other than claude-code, a sandbox
 * spawn, or a label without a grant. Unreadable rules are dropped.
 */
export function permissionAllowFor(
  defaults: SpawnDefaultsConfig | undefined,
  target: { adapter: string | undefined; label: string | undefined; sandbox?: unknown },
): string[] | undefined {
  if (target.sandbox !== undefined) return undefined
  if (target.adapter === undefined || !GRANT_ADAPTERS.has(target.adapter)) return undefined
  if (!target.label) return undefined
  const grants = defaults?.permissionGrants ?? DEFAULT_PERMISSION_GRANTS
  const rules = grants[target.label]
  if (!Array.isArray(rules)) return undefined
  const valid = rules.filter((r): r is string => typeof r === "string" && PERMISSION_RULE_PATTERN.test(r))
  return valid.length > 0 ? [...new Set(valid)] : undefined
}
