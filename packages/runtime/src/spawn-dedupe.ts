/**
 * Policy layer for `agent_start`'s implicit-dedupe default (the daemon-side
 * `spawn.dedupe` policy) — kept deliberately separate (and pure where
 * possible) from the claim/fork plumbing in `session-spawn.ts`, exactly as
 * `spawn-attach.ts` is for `agent_start.attach` and `worktree-isolation.ts`
 * is for `agent_start.worktree`.
 *
 * The problem it fixes: `idempotencyKey` (session-spawn.ts's `SpawnClaim`)
 * only guards a retry that REMEMBERS to ask for the guard. An operator who
 * forgets it — the same operator who wrote the guard, in the incident that
 * motivated it — gets zero protection: two spawns, no key, four sessions,
 * two agents mutating one git worktree concurrently. `spawn.attach`
 * (`config.ts`'s `SpawnConfig.attach` docblock) already settled this exact
 * argument for parent lineage: a guard that only works when a caller
 * remembers to opt in is not a guard. This module extends that precedent to
 * the fork-safety guard itself, by deriving an IMPLICIT key when the caller
 * supplied none.
 *
 * False-dedup analysis — why the implicit key is `label` + a hash of the
 * initial `prompt`, and nothing looser:
 *
 *   - `adapter` and `cwd` alone are already folded into every claim's map
 *     key by `session-spawn.ts` (`${adapter}\x1f${cwd}\x1f${key}`), for
 *     both explicit and implicit keys — so they're not this module's
 *     decision to make; the question here is only what goes in `${key}`.
 *   - A shared `cwd` ALONE is far too noisy to key off: this file's own
 *     test suite exercises a legitimate orchestrator fan-out where several
 *     structurally-identical `agent_start` calls (same adapter, same cwd,
 *     no label, no prompt) under one caller scope are REQUIRED to spawn as
 *     distinct sessions — an implicit key derived from cwd alone would
 *     collapse every one of those down to one process, which is a worse bug
 *     than the one this feature fixes.
 *   - PR #803 already drew this exact line for its own no-opt-in backstop
 *     (the "another LIVE session already has the same label and cwd"
 *     warning in `session-spawn.ts`): a shared `label`, not `cwd` alone, is
 *     the actual signal, because unlabelled parallel fan-out into one cwd
 *     is routine here and a label-less warning would fire on essentially
 *     every multi-agent worktree run, training operators to ignore it. This
 *     module reuses that SAME boundary rather than inventing a new one:
 *     `deriveImplicitIdempotencyKey` returns `undefined` — no implicit key,
 *     spawn untouched, byte-for-byte today's behaviour — whenever `label`
 *     is absent (or blank). A deliberate parallel fan-out that doesn't
 *     label its children (the exercised pattern) is therefore structurally
 *     excluded from implicit dedup, not merely discouraged from it.
 *   - A hash of the initial `prompt` is folded in on top of `label`,
 *     tightening the match further at essentially zero cost to true
 *     positives: a genuine retry (the caller's own request replayed after a
 *     dropped response) re-sends byte-identical arguments, so its prompt
 *     hash always matches the original. What it buys back is the case
 *     where an operator or a piece of automation deliberately reuses ONE
 *     label across successive, differently-worded turns into the same cwd
 *     — e.g. the inbound-watcher spawn pattern in `orchestration-tools.ts`,
 *     which reuses a single `label` suffix across every message it relays
 *     but always sends a different `promptTemplate` expansion. Without the
 *     prompt hash, that pattern's second (and every subsequent) spawn would
 *     silently collapse onto the first inside the implicit window; with it,
 *     only a truly identical re-send collapses.
 *
 * Candidates deliberately left OUT: `adapter` alone (too coarse — see
 * above, it's already structural, not a choice); a hash of the FULL input
 * object (would defeat its own purpose — a retry's `wait`/timing metadata
 * can legitimately differ call to call, so hashing everything reintroduces
 * false negatives on the exact retries this exists to catch).
 */

import { createHash } from "node:crypto"
import { loadConfig } from "./config.js"
import type { SpawnDedupeMode } from "./config.js"

export type { SpawnDedupeMode }

/** Env override for the dedupe policy. Highest-priority source, ahead of
 *  the `spawn.dedupe` config field — see `loadSpawnDedupe`. */
export const SPAWN_DEDUPE_ENV = "AGENTPROTO_SPAWN_DEDUPE"

/** The default when nothing is configured. Mirrors `attach`: deriving is
 *  ON by default because the false-dedup boundary (label-gated, see the
 *  module docblock) already excludes the one pattern (unlabelled fan-out)
 *  that would make "always" unsafe. */
export const DEFAULT_SPAWN_DEDUPE: SpawnDedupeMode = "always"

/** Namespace prefix for a derived key, built from NUL + unit-separator --
 *  control characters no caller's `idempotencyKey` string could plausibly
 *  contain -- so an implicit key can never collide with (and silently be
 *  mistaken for) a caller-supplied explicit one sharing the same text. */
const IMPLICIT_KEY_PREFIX = "\x00implicit\x1f"

/**
 * Derive the implicit dedupe key for a spawn, or `undefined` when derivation
 * doesn't apply — see the module docblock for the full false-dedup
 * reasoning. Pure and synchronous: no registry/claim-map access here, only
 * the two input fields the key is built from.
 *
 * Returns `undefined` whenever `label` is absent or blank — the fan-out
 * safety boundary. A present label combines with a SHA-256 of the initial
 * `prompt` (truncated to 16 hex chars — plenty of collision resistance for
 * a short-lived in-memory dedup key, not a security boundary) so two spawns
 * sharing a label but carrying genuinely different instructions are never
 * merged.
 */
export function deriveImplicitIdempotencyKey(input: {
  label?: string
  prompt?: string
}): string | undefined {
  const label = input.label?.trim()
  if (!label) return undefined
  const promptHash = createHash("sha256")
    .update(input.prompt ?? "")
    .digest("hex")
    .slice(0, 16)
  return `${IMPLICIT_KEY_PREFIX}${label}\x1f${promptHash}`
}

/** Parse a raw string into a valid mode, or `undefined` when it isn't one. */
export function parseSpawnDedupeMode(
  raw: string | undefined,
): SpawnDedupeMode | undefined {
  return raw === "always" || raw === "on-request" ? raw : undefined
}

/**
 * Resolve the effective dedupe mode: env > config field > default. Mirrors
 * `loadSpawnAttach`'s precedence exactly. Never throws: an unreadable
 * config falls through to the default.
 */
export async function loadSpawnDedupe(
  loadCfg: () => Promise<{ spawn?: { dedupe?: SpawnDedupeMode } }> = loadConfig,
): Promise<SpawnDedupeMode> {
  const fromEnv = parseSpawnDedupeMode(process.env[SPAWN_DEDUPE_ENV])
  if (fromEnv) return fromEnv
  try {
    const cfg = await loadCfg()
    const fromCfg = parseSpawnDedupeMode(cfg.spawn?.dedupe)
    if (fromCfg) return fromCfg
  } catch {
    // fall through to default
  }
  return DEFAULT_SPAWN_DEDUPE
}
