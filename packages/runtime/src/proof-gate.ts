/**
 * AIP-46 spawn proof gate, counters always on.
 *
 * AIP-46 §Session principals has three proof levels: `proven` (the caller
 * presented a credential: a scoped orchestrator token, or a session token
 * minted for the session it claims), `claimed` (it only named a session) and
 * `none` (it named none, which on loopback is the operator, rule 5). Rule 9
 * lets a host list actions that require `proven`; a `claimed` caller of a
 * listed action is refused `identity_unverified`, a caller whose token names
 * another session than its claim is refused `identity_mismatch`.
 *
 * The list is opt-in and defaults empty. Enforcement cannot outrun delivery
 * (rule 8): a session whose adapter or placement could not carry a token can
 * never be proven, so listing `session:spawn` would break it. The counters
 * here let the operator read who would be refused before listing anything.
 *
 * The observer is a module-level singleton on purpose: `spawnAgentSession`
 * is reached from agent-tools, http-server, session-tools and cron, which
 * share no object. Counters live in memory (a restart resets them). The
 * caller id is a session id, never a secret; no token, credential id or hash
 * ever reaches the log or the report.
 */

import type { ClaimOnlyClass } from "./identity-observations.js"
import type { SessionDescriptor } from "./sessions.js"
import { hasSessionCredential } from "./session-credentials.js"
import { sessionTokenDeliverySafe } from "./identity-defaults.js"

/** What the gate concluded for one spawn. */
export type SpawnProofVerdict =
  | "proven" // a scope token, or a credential minted for the claimed session
  | "claimed" // a known internal session was named without its credential
  | "mismatch" // a credential was presented, but for another session than the claim
  | "none" // no trusted caller: the operator on loopback, or a host-owned continuation
  | "caller_unknown" // a trusted caller id the registry does not hold (counted, never refused)
  | "external" // a `kind: "external"` label, evaluated as anonymous (rule 7)

export interface SpawnProofDecisionInput {
  /** Trusted caller session id (`callerScope.ownerSessionId`, else the
   *  daemon-derived `autoParentSessionId`, else the transport `callerSessionId`).
   *  NEVER the caller-supplied `parentSessionId` hint. */
  callerSessionId: string | undefined
  /** Whether the registry holds that caller id. */
  callerKnown: boolean
  /** The caller is a `kind: "external"` row: a label the host did not spawn. */
  callerExternal?: boolean
  /** A `callerScope` is present: its unspoofable token IS the credential. */
  scoped: boolean
  /** The session a valid session token on this request was minted for. */
  credentialSessionId: string | undefined
}

/** The pure decision. No I/O, no configuration read. */
export function decideSpawnProof(input: SpawnProofDecisionInput): SpawnProofVerdict {
  if (input.callerSessionId === undefined) return "none"
  if (!input.callerKnown) return "caller_unknown"
  if (input.callerExternal === true) return "external"
  if (input.scoped) return "proven"
  if (input.credentialSessionId !== undefined) {
    return input.credentialSessionId === input.callerSessionId ? "proven" : "mismatch"
  }
  return "claimed"
}

/**
 * The trusted caller id shared by every spawn gate: the scoped orchestrator
 * owner first, then the daemon-derived auto-parent, then the transport's
 * caller id. Never `input.parentSessionId` (a caller-supplied hint).
 */
export function spawnGateCallerId(
  callerScope: { ownerSessionId?: string } | undefined,
  input: { autoParentSessionId?: string; callerSessionId?: string },
): string | undefined {
  return callerScope?.ownerSessionId ?? input.autoParentSessionId ?? input.callerSessionId
}

/**
 * What a claim without a token names (AIP-46 rules 7 and 8): an external
 * label, a host-spawned session the token was delivered to, one it could not
 * be delivered to (adapter or placement), or an id the registry does not
 * know. Shared by the HTTP observer and the spawn proof gate so the two
 * classifications cannot drift.
 */
export function claimClassOf(
  id: string,
  descriptor: SessionDescriptor | undefined,
): ClaimOnlyClass {
  if (!descriptor) return "unknown"
  if (descriptor.kind === "external") return "external"
  // Every sandbox provider (the built-in `local` included) stamps
  // `remote: true` alongside its `sandboxId`; treating either as a sandboxed
  // placement keeps a boxed claude-code row `undelivered` (rule 8).
  const sandboxed = descriptor.remote === true || descriptor.sandboxId !== undefined ? true : undefined
  return sessionTokenDeliverySafe(descriptor.adapterSlug, sandboxed) && hasSessionCredential(id)
    ? "delivered"
    : "undelivered"
}

/** Actions whose callers must be `proven`. Only what this build evaluates. */
export type RequireProofAction = "session:spawn"

export const REQUIRE_PROOF_ACTIONS: readonly RequireProofAction[] = ["session:spawn"]

export interface SpawnProofReport {
  /** ISO time this process started counting (resets on a restart). */
  since: string
  counts: Record<SpawnProofVerdict, number>
  /** `claimed` readings split by whether a token was ever deliverable. */
  claimedByClass: { delivered: number; undelivered: number }
  /** Readings a listing of `session:spawn` would refuse: claimed + mismatch. */
  wouldRefuse: number
  /** Readings actually refused. */
  refused: number
  /** Readings where the action was listed but tokens were off (rule 8). */
  requireProofIgnored: number
  /** The actions currently listed (`defaults.identity.requireProof`). */
  requireProof: RequireProofAction[]
}

let since = new Date().toISOString()
let counts: Record<SpawnProofVerdict, number> = emptyCounts()
let claimedByClass = { delivered: 0, undelivered: 0 }
let refused = 0
let requireProofIgnored = 0
let warnedPairs = new Set<string>()
let warnedIgnored = false

function emptyCounts(): Record<SpawnProofVerdict, number> {
  return {
    proven: 0,
    claimed: 0,
    mismatch: 0,
    none: 0,
    caller_unknown: 0,
    external: 0,
  }
}

export function recordSpawnProof(
  verdict: SpawnProofVerdict,
  ctx: {
    /** `session:spawn` was listed in `defaults.identity.requireProof`. */
    listed: boolean
    /** This reading was actually refused. */
    refused: boolean
    /** The claim class, for a `claimed` caller. */
    claimClass?: ClaimOnlyClass
    surface: "scoped" | "mcp"
    /** The caller session id, for the one-time warning. Never a token. */
    callerId?: string
    /** Whether the daemon mints tokens at all. `false` with `listed` means the list is ignored (rule 8). */
    tokensOn?: boolean
  },
): void {
  counts[verdict] += 1
  if (ctx.refused) refused += 1
  if (verdict === "claimed" && (ctx.claimClass === "delivered" || ctx.claimClass === "undelivered")) {
    claimedByClass[ctx.claimClass] += 1
  }

  // Only the readings an operator would act on are logged: a `claimed` or
  // `mismatch` caller. `proven`, `none` (the operator), `external` and
  // `caller_unknown` are the normal traffic and stay counter-only.
  const pair = `${verdict}|${ctx.claimClass ?? "-"}`
  if ((verdict === "claimed" || verdict === "mismatch") && !warnedPairs.has(pair)) {
    warnedPairs.add(pair)
    console.warn(
      `[spawn-proof] ${verdict} (class ${ctx.claimClass ?? "-"}) caller=${ctx.callerId ?? "-"} surface ${ctx.surface}`,
    )
  }

  if (ctx.listed && ctx.tokensOn === false) {
    requireProofIgnored += 1
    if (!warnedIgnored) {
      warnedIgnored = true
      console.warn(
        `[spawn-proof] defaults.identity.requireProof lists "session:spawn" but defaults.identity.sessionTokens is "off"; the list is ignored until tokens are minted.`,
      )
    }
  }
}

export function spawnProofReport(requireProof: readonly RequireProofAction[]): SpawnProofReport {
  return {
    since,
    counts: { ...counts },
    claimedByClass: { ...claimedByClass },
    wouldRefuse: counts.claimed + counts.mismatch,
    refused,
    requireProofIgnored,
    requireProof: [...requireProof],
  }
}

/** Tests only: forget every observation and restart the `since` clock. */
export function resetSpawnProofObservations(): void {
  since = new Date().toISOString()
  counts = emptyCounts()
  claimedByClass = { delivered: 0, undelivered: 0 }
  refused = 0
  requireProofIgnored = 0
  warnedPairs = new Set()
  warnedIgnored = false
}
