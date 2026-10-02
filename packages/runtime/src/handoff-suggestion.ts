/**
 * Cross-harness handoff SUGGESTIONS. agentproto only ever proposes a switch —
 * the user runs `agentproto sessions handoff <id> --to <harness>` (or answers
 * a `handoff:<harness>` option) to make it happen. Nothing here spawns.
 */

import type { AdapterCapabilitiesLister } from "./http-server.js"
import type { HandoffSuggestionReason } from "./session-event-bus.js"

/** Prefix of the `awaitingQuestion` option that answers "hand off to <harness>". */
export const HANDOFF_OPTION_PREFIX = "handoff:"

/** Most suggestions put in front of the user at once. */
const MAX_SUGGESTIONS = 3

const HARNESS_DISPLAY_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-sdk": "Claude SDK",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  pi: "Pi",
}

export function harnessDisplayName(slug: string): string {
  return HARNESS_DISPLAY_NAMES[slug] ?? slug
}

export function handoffCommand(sessionId: string, harness: string): string {
  return `agentproto sessions handoff ${sessionId} --to ${harness}`
}

/** The `handoff:<harness>` slug of an answer option, or undefined. */
export function parseHandoffOption(option: string): string | undefined {
  if (!option.toLowerCase().startsWith(HANDOFF_OPTION_PREFIX)) return undefined
  const harness = option.slice(HANDOFF_OPTION_PREFIX.length).trim()
  return harness.length > 0 ? harness : undefined
}

/**
 * Installed harnesses a session could move to: the capability record of an
 * installed adapter shows at least one billing provider with a credential
 * present (the same discovery `harness_capabilities` exposes), and it is not
 * the harness the session already runs on. Best-effort — a missing lister or
 * a failing one yields no candidates, never an error.
 */
export async function listHandoffHarnesses(
  fromHarness: string,
  listHarnessCapabilities: AdapterCapabilitiesLister | undefined,
): Promise<string[]> {
  if (!listHarnessCapabilities) return []
  try {
    const caps = await listHarnessCapabilities()
    const seen = new Set<string>()
    for (const cap of caps) {
      if (cap.adapter === fromHarness) continue
      if (!cap.providers.some(p => p.cred.present)) continue
      seen.add(cap.adapter)
    }
    return [...seen].slice(0, MAX_SUGGESTIONS)
  } catch {
    return []
  }
}

export function buildHandoffSuggestions(
  sessionId: string,
  harnesses: readonly string[],
): Array<{ harness: string; command: string }> {
  return harnesses.map(harness => ({ harness, command: handoffCommand(sessionId, harness) }))
}

/** Readable transcript lines, one per suggestion, command in clear. */
export function handoffSuggestionLines(opts: {
  sessionId: string
  fromHarness: string
  reason: HandoffSuggestionReason
  suggestions: ReadonlyArray<{ harness: string; command: string }>
  /** Remaining quota + window, for `quota-threshold`. */
  quota?: { remaining: number; window: string }
}): string[] {
  const from = harnessDisplayName(opts.fromHarness)
  const lead =
    opts.reason === "provider-limit"
      ? `${from} hit its usage limit.`
      : `${from} quota is running low${
          opts.quota ? ` (${opts.quota.remaining} remaining in the ${opts.quota.window} window)` : ""
        }.`
  return opts.suggestions.map(
    s => `[handoff] ${lead} Hand off to ${harnessDisplayName(s.harness)}? ${s.command}`,
  )
}
