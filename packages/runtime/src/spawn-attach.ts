/**
 * Policy layer for `agent_start.attach` — the config-driven decision of WHO a
 * spawn nests under, kept deliberately separate (and pure) from the spawn
 * plumbing in `session-spawn.ts`, exactly as `worktree-isolation.ts` is for
 * `agent_start.worktree`.
 *
 * The problem it fixes: on the plain `/mcp` path (no scoped orchestrator
 * gateway), a spawn was attributed to a parent ONLY when the caller passed an
 * explicit `parentSessionId` hint — so a supervisor that spawned an executor
 * without wiring itself as an orchestrator produced a depth-0 ORPHAN. The
 * daemon already knows the caller's own id on that path (the trusted
 * `?callerSessionId=` query the self-ref `mcpServers` URL carries — PR 7 /
 * Gap 7), it just wasn't being used for lineage. This module decides whether
 * to use it.
 *
 * Trust boundary (unchanged from the hint): the scoped `/mcp/orchestrator`
 * gateway's token is the UNSPOOFABLE source — when a `callerScope` is present
 * the caller derives its parent from the token and this whole module is
 * bypassed (see `session-spawn.ts`). Everything here is descriptor-only
 * lineage on the anonymous root path; it never moves the gating `childDepth`
 * and so never relaxes a depth-gated worktree/role guard.
 */

import { loadConfig } from "./config.js"
import type { SpawnAttachMode } from "./config.js"

export type { SpawnAttachMode }

/** Env override for the attach policy. Highest-priority source, ahead of the
 *  `spawn.attach` config field — see `loadSpawnAttach`. */
export const SPAWN_ATTACH_ENV = "AGENTPROTO_SPAWN_ATTACH"

/** The default when nothing is configured. Unlike worktree isolation, attach
 *  defaults ON: an orphaned executor is a bug, and the auto-parent is pure
 *  lineage that gates nothing. */
export const DEFAULT_SPAWN_ATTACH: SpawnAttachMode = "always"

/**
 * The `agent_start.attach` field. `true` opts in to attaching under the
 * derived parent (the caller's own id / an explicit hint) even when the
 * policy is `on-request`; an object additionally pins an explicit parent id;
 * `false` forces an INDEPENDENT root (no parent, depth 0) regardless of
 * policy or derivable identity — the deliberate "launch detached" escape
 * hatch, mirroring `worktree: false`. Omitted ⇒ the policy mode decides.
 */
export type AttachField = boolean | { parent?: string }

/** The normalized request. `detached` short-circuits everything to an
 *  independent root. `parent` is an explicit pin (from `{ parent }`). `optIn`
 *  is `true` for a bare `attach: true`. All absent ⇒ no explicit request. */
export interface AttachRequest {
  detached?: boolean
  parent?: string
  optIn?: boolean
}

/** The pure decision: the parent id to record (or `undefined` for a root). */
export interface AttachDecision {
  /** Session id to record as `parentSessionId`, or `undefined` for a root. */
  parent?: string
  /** True when the child was deliberately detached (`attach: false`) — lets
   *  the caller distinguish "no parent was derivable" from "an independent
   *  root was requested", for logging. */
  detached: boolean
}

/**
 * Normalize the raw field into an explicit request, or `undefined` when the
 * field is absent (the policy mode alone decides). `false` normalizes to
 * `{ detached: true }`; `true` to `{ optIn: true }`; an object carries its
 * `parent` pin (and is itself an opt-in).
 */
export function normalizeAttachField(
  field: AttachField | undefined,
): AttachRequest | undefined {
  if (field === undefined) return undefined
  if (field === false) return { detached: true }
  if (field === true) return { optIn: true }
  const request: AttachRequest = { optIn: true }
  if (field.parent !== undefined) request.parent = field.parent
  return request
}

/**
 * The resolution matrix — request × policy × derivable-parent — with no side
 * effects. Every branch is exercised in `spawn-attach.test.ts`.
 *
 * `autoParent` is the daemon-derived caller id (trusted `?callerSessionId=`),
 * `hint` is the caller-supplied `parentSessionId`. An explicit pin
 * (`{ parent }`) wins over both; otherwise `hint` (an explicit caller
 * request) is preferred over `autoParent` (an implicit default). The MODE
 * only governs whether that derived candidate is applied when the caller made
 * NO explicit attach choice:
 *   - `always` (default): candidate applied ⇒ attach by default.
 *   - `on-request`: candidate NOT applied unless the caller opted in
 *     (`attach: true` / `{ parent }`) or passed an explicit `hint`.
 * `attach: false` (detached) always wins, producing a root even when a parent
 * was derivable.
 */
export function decideSpawnAttach(input: {
  mode: SpawnAttachMode
  field: AttachField | undefined
  /** Daemon-derived caller session id (trusted `?callerSessionId=` query). */
  autoParent?: string
  /** Caller-supplied `parentSessionId` hint. */
  hint?: string
}): AttachDecision {
  const request = normalizeAttachField(input.field)

  // Deliberate detach — an independent root regardless of anything else.
  if (request?.detached) return { parent: undefined, detached: true }

  // Explicit pin wins over every derived source.
  if (request?.parent) return { parent: request.parent, detached: false }

  // Preferred derived candidate: an explicit hint outranks the implicit auto.
  const candidate = input.hint ?? input.autoParent

  // Opted in (`attach: true`) — attach to the candidate regardless of mode.
  if (request?.optIn) return { parent: candidate, detached: false }

  // No explicit choice — the mode decides whether to apply the candidate.
  switch (input.mode) {
    case "always":
      return { parent: candidate, detached: false }
    case "on-request":
      // Only an explicit caller hint attaches; the implicit auto-parent does
      // not (this is the pre-attach behaviour, preserved for opt-out sites).
      return { parent: input.hint, detached: false }
  }
}

/** Parse a raw string into a valid mode, or `undefined` when it isn't one. */
export function parseSpawnAttachMode(
  raw: string | undefined,
): SpawnAttachMode | undefined {
  return raw === "always" || raw === "on-request" ? raw : undefined
}

/**
 * Resolve the effective attach mode: env > config field > default. Mirrors
 * `loadWorktreeIsolation`'s precedence. Never throws: an unreadable config
 * falls through to the default.
 */
export async function loadSpawnAttach(
  loadCfg: () => Promise<{ spawn?: { attach?: SpawnAttachMode } }> = loadConfig,
): Promise<SpawnAttachMode> {
  const fromEnv = parseSpawnAttachMode(process.env[SPAWN_ATTACH_ENV])
  if (fromEnv) return fromEnv
  try {
    const cfg = await loadCfg()
    const fromCfg = parseSpawnAttachMode(cfg.spawn?.attach)
    if (fromCfg) return fromCfg
  } catch {
    // fall through to default
  }
  return DEFAULT_SPAWN_ATTACH
}
