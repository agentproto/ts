/**
 * ORPHAN-BOX gc for the PROVIDER control plane.
 *
 * `sandbox-gc.ts` reaps boxes the daemon's own ledger knows about: a row
 * whose origin session died. That misses a whole class of boxes - the ones
 * the PROVIDER still holds while the daemon has no row for them at all:
 *
 *   - a computer the controller created for a session that died before the
 *     ledger row was written (or after the daemon restarted and lost it),
 *   - a box a daemon from another host created on the SHARED controller,
 *   - a box whose ledger row was removed by hand.
 *
 * Such a box is invisible to the ledger gc but not to the provider: the
 * controller keeps it (and its RAM - a suspended computer holds a snapshot)
 * and keeps counting its session slots, so every later launch can fail with
 * "host capacity" while the stale boxes sit there.
 *
 * This module is the provider-side half of the gc:
 *
 *   1. LIST the provider's boxes (`SandboxProvider.listBoxes`).
 *   2. Select the ORPHANS: boxes the daemon's sandbox registry does not
 *      know AND that no live daemon session holds. A box held by a live
 *      session is NEVER a candidate, whatever else is true of it.
 *   3. DELETE them with `remove(id, { force: true })` - forced, because a
 *      stale controller-side session slot would otherwise make the
 *      controller refuse the destroy with a 409.
 *
 * Every provider is scanned INDEPENDENTLY: a controller that errors (down,
 * unauthorized, mid-deploy) is reported as an error for THAT provider and
 * never stops the gc of the others.
 */
import type { SandboxProviderBox } from "@agentproto/sandbox"
import { GONE_RE, isGoneError } from "./sandbox-gc.js"
import type { SandboxGcProviderHandle } from "./sandbox-gc.js"

/** Host session statuses after which a session can never hold a box again. */
const DEAD_SESSION_STATUSES: ReadonlySet<string> = new Set(["error", "killed", "exited"])

/** Grace window a box must age out of before it can be an orphan
 *  candidate: a box younger than this may still be booting, attaching, or
 *  simply not yet reported by the daemon's ledger. 15 minutes. */
export const ORPHAN_GRACE_MS = 15 * 60 * 1000

/** One box the provider still holds that no live session references. */
export interface SandboxOrphanCandidate {
  /** Provider slug the box belongs to ("computer", …). */
  provider: string
  /** Provider-assigned box id. */
  boxId: string
  /** Provider-reported state ("running", "stopped", …) when known. */
  state: string
  /** Why this box is an orphan - always says what was checked. */
  reason: string
  /** Session slots the provider still counts for the box, when known. */
  sessions?: number
  /** Memory the box holds (MiB), when the provider reports it. */
  memoryMiB?: number
  /** Age of the box in milliseconds, when the provider reports a creation
   *  time. */
  ageMs?: number
}

/**
 * Select the orphan boxes of ONE provider.
 *
 * A box is a candidate when it is
 *   - unknown to the daemon's sandbox registry (the ledger), AND
 *   - held by no live daemon session, AND
 *   - PAST THE GRACE WINDOW: older than `graceMs` (15 minutes by default).
 *     A box the provider does not date (or that is younger than the
 *     window) can never be proven stale, so it is NOT a candidate: a box
 *     that is still booting, still attaching, or simply not yet in the
 *     ledger must survive the sweep. AND
 *   - attached to NO provider-side session (`sessions === 0`): a box the
 *     controller still counts a session on is IN USE by somebody the
 *     daemon cannot see. `includeAttached` drops that check (an explicit
 *     operator override - the CLI's `--include-attached`).
 *
 * A box held by a live session is skipped even when the ledger does not
 * know it: the live session is the authority on what is in use, and the
 * gc must never destroy a box somebody is using.
 */
export function collectProviderOrphanCandidates(opts: {
  provider: string
  boxes: readonly SandboxProviderBox[]
  /** Box ids the daemon's sandbox registry (ledger) knows. */
  registryBoxIds: ReadonlySet<string>
  /** Box ids held by a live daemon session. */
  liveBoxIds: ReadonlySet<string>
  /** Grace window on the box age, in ms (default {@link ORPHAN_GRACE_MS}). */
  graceMs?: number
  /** Also propose boxes the provider still counts a session on. */
  includeAttached?: boolean
  /** Clock injection for the age computation (tests). */
  now?: number
}): SandboxOrphanCandidate[] {
  const now = opts.now ?? Date.now()
  const graceMs = opts.graceMs ?? ORPHAN_GRACE_MS
  const includeAttached = opts.includeAttached === true
  const out: SandboxOrphanCandidate[] = []
  for (const box of opts.boxes) {
    if (opts.liveBoxIds.has(box.id)) continue
    if (opts.registryBoxIds.has(box.id)) continue
    const ageMs = ageOf(box, now)
    if (ageMs === undefined) continue
    if (ageMs < graceMs) continue
    // Unknown session count (provider did not report it) is NOT proof of
    // "no attached session": only an explicit `sessions === 0` qualifies.
    const sessions = box.sessions
    if (!includeAttached && sessions !== 0) continue
    out.push({
      provider: opts.provider,
      boxId: box.id,
      state: box.state ?? "unknown",
      reason:
        "not in the daemon's sandbox registry, held by no live session, " +
        `older than the ${Math.round(graceMs / 60_000)}min grace window` +
        (sessions === undefined
          ? " (the provider did not report attached sessions - unknown" +
            (includeAttached ? ", proposed anyway, --include-attached)" : ")")
          : sessions > 0
            ? ` (the provider still counts ${sessions} attached session(s)` +
              (includeAttached ? " - proposed anyway, --include-attached)" : ")")
            : " (no attached session)"),
      ...(box.sessions !== undefined ? { sessions: box.sessions } : {}),
      ...(box.memoryMiB !== undefined ? { memoryMiB: box.memoryMiB } : {}),
      ...(ageMs !== undefined ? { ageMs } : {}),
    })
  }
  return out
}

/** A provider that is not configured at all (no controller URL/token) has
 *  no control plane to sweep - not a gc failure. */
function isNotConfiguredError(message: string): boolean {
  return /missing controller|not configured|no controller url/i.test(message)
}

/** Age in ms of a box, when the provider reported a creation time. */function ageOf(box: SandboxProviderBox, now: number): number | undefined {
  if (box.createdAt === undefined) return undefined
  const created = Date.parse(box.createdAt)
  if (!Number.isFinite(created)) return undefined
  return Math.max(0, now - created)
}

/** The result of scanning ONE provider. */
export interface SandboxOrphanScan {
  provider: string
  /** The provider's orphan boxes. Empty when the provider errored. */
  candidates: SandboxOrphanCandidate[]
  /** Why the provider could not be scanned - when it could not. */
  error?: string
  /** True when the provider's control plane was actually ENUMERATED.
   *  False when the sweep never ran for that provider (not configured, no
   *  control plane, no `listBoxes`, or an error) - the difference between
   *  "no orphan" and "not looked at". */
  scanned: boolean
  /** Why the provider was not scanned (when it was not). */
  skipped?: string
}

export interface SandboxOrphanScanDeps {
  resolveProvider: (slug: string) => Promise<SandboxGcProviderHandle | null>
  /** Provider slugs to scan. */
  providerSlugs: readonly string[]
  /** Box ids the daemon's sandbox registry (ledger) knows. */
  registryBoxIds: ReadonlySet<string>
  /** Box ids held by a live daemon session. */
  liveBoxIds: ReadonlySet<string>
  /** Grace window on the box age, in ms (default {@link ORPHAN_GRACE_MS}). */
  graceMs?: number
  /** Also propose boxes the provider still counts a session on. */
  includeAttached?: boolean
  now?: number
}

/** Providers whose boxes cannot be ATTRIBUTED to this daemon. The orphan
 *  rule ("not in THIS daemon's ledger") only holds when the provider scopes
 *  its boxes to this daemon; a shared account holds boxes from other
 *  daemons, machines, CI and tools, and all of them would look like
 *  orphans. Such a provider may only be swept when its boxes carry a
 *  metadata marker written at boot by this daemon. */
const PROVIDERS_REQUIRING_DAEMON_MARKER: ReadonlySet<string> = new Set(["e2b"])

/** Why a provider cannot be attributed to this daemon, when it writes no
 *  marker at boot. `@agentproto/sandbox-e2b` writes NO metadata on
 *  `Sandbox.create`, so every box on a shared e2b account - including
 *  another daemon's, another machine's, or CI's - is indistinguishable
 *  from an orphan here. */
function missingDaemonMarkerReason(slug: string): string | undefined {
  if (!PROVIDERS_REQUIRING_DAEMON_MARKER.has(slug)) return undefined
  return (
    `the ${slug} provider writes no daemon marker at boot, so its boxes ` +
    "cannot be attributed to this daemon; its account is shared with other " +
    "daemons, machines, CI and tools - refusing to sweep it"
  )
}

/**
 * Scan every provider for orphan boxes. One provider's failure is reported
 * on that provider's scan and never aborts the others.
 *
 * A provider that cannot be enumerated (not configured, no control plane,
 * no `listBoxes`) is reported as NOT SCANNED - never as "no orphan found".
 */
export async function scanSandboxProviderOrphans(
  deps: SandboxOrphanScanDeps,
): Promise<SandboxOrphanScan[]> {
  const scans: SandboxOrphanScan[] = []
  for (const slug of deps.providerSlugs) {
    const noMarker = missingDaemonMarkerReason(slug)
    if (noMarker !== undefined) {
      scans.push({ provider: slug, candidates: [], scanned: false, skipped: noMarker })
      continue
    }
    let handle: SandboxGcProviderHandle | null = null
    try {
      handle = await deps.resolveProvider(slug)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      scans.push({
        provider: slug,
        candidates: [],
        error: message,
        scanned: false,
        skipped: message,
      })
      continue
    }
    if (!handle) {
      scans.push({
        provider: slug,
        candidates: [],
        scanned: false,
        skipped: "the provider is not configured (no control plane to sweep)",
      })
      continue
    }
    const listBoxes = handle.provider.listBoxes
    if (typeof listBoxes !== "function") {
      scans.push({
        provider: slug,
        candidates: [],
        scanned: false,
        skipped: "the provider cannot enumerate its boxes (no listBoxes)",
      })
      continue
    }
    let boxes: SandboxProviderBox[]
    try {
      boxes = await listBoxes.call(handle.provider)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A provider that is simply NOT CONFIGURED (no controller URL/token
      // in the creds store or the env) is not a gc failure: there is no
      // control plane to sweep. Anything else is a real error for THAT
      // provider - reported, and never fatal for the others.
      if (isNotConfiguredError(message)) {
        scans.push({
          provider: slug,
          candidates: [],
          scanned: false,
          skipped: message,
        })
        continue
      }
      scans.push({
        provider: slug,
        candidates: [],
        error: message,
        scanned: false,
        skipped: message,
      })
      continue
    }
    scans.push({
      provider: slug,
      scanned: true,
      candidates: collectProviderOrphanCandidates({
        provider: slug,
        boxes,
        registryBoxIds: deps.registryBoxIds,
        liveBoxIds: deps.liveBoxIds,
        ...(deps.graceMs !== undefined ? { graceMs: deps.graceMs } : {}),
        ...(deps.includeAttached !== undefined ? { includeAttached: deps.includeAttached } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      }),
    })
  }
  return scans
}

/** The outcome of deleting one orphan box. */
export type SandboxOrphanReapResult = { ok: true } | { ok: false; error: string }

/**
 * Delete one orphan box on its provider. FORCED: the box may still carry
 * stale controller-side session slots, and without `force` the controller
 * refuses the destroy with a 409 ("still in use") - the very state that
 * keeps the box's RAM pinned. The candidate list already proved no LIVE
 * session holds the box.
 */
export async function reapSandboxOrphan(
  candidate: SandboxOrphanCandidate,
  deps: { resolveProvider: (slug: string) => Promise<SandboxGcProviderHandle | null> },
): Promise<SandboxOrphanReapResult> {
  let handle: SandboxGcProviderHandle | null
  try {
    handle = await deps.resolveProvider(candidate.provider)
  } catch (err) {
    return {
      ok: false,
      error: `provider "${candidate.provider}" could not be resolved - ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
  if (!handle) {
    return { ok: false, error: `provider "${candidate.provider}" not found.` }
  }
  if (typeof handle.provider.remove !== "function") {
    return {
      ok: false,
      error: `provider "${candidate.provider}" cannot destroy a box without a control-plane remove().`,
    }
  }
  try {
    await handle.provider.remove(candidate.boxId, { force: true })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Already gone is success: the goal (the box is not there any more)
    // holds either way. The SHARED gone-detection (`GONE_RE` /
    // `isGoneError`, the same one the ledger gc uses) is used here, so a
    // "not found" that is NOT about the box (e.g. `provider "x" not
    // found`) is never stamped as a successful reap.
    if (isGoneError(err) || GONE_RE.test(message)) {
      return { ok: true }
    }
    return { ok: false, error: `removing "${candidate.boxId}" failed - ${message}` }
  }
}

/** A session row as far as the gc needs it. */
export interface SandboxGcLiveSession {
  id?: string
  status?: string
  sandboxId?: string
}
/**
 * The box ids held by LIVE sessions. A session that ended in a terminal
 * failure state holds nothing any more; a session whose status is unknown
 * is treated as LIVE (conservative: an unknown holder must never lose its
 * box).
 */
export function liveSessionBoxIds(sessions: readonly SandboxGcLiveSession[]): Set<string> {
  const out = new Set<string>()
  for (const s of sessions) {
    if (typeof s.sandboxId !== "string" || s.sandboxId.length === 0) continue
    if (typeof s.status === "string" && DEAD_SESSION_STATUSES.has(s.status)) continue
    out.add(s.sandboxId)
  }
  return out
}

/** The outcome of one orphan-gc pass (the MCP tool's / CLI's shared shape). */
export interface SandboxOrphanGcPassResult {
  /** The orphan boxes the pass found (always listed, apply or not). */
  candidates: SandboxOrphanCandidate[]
  /** Providers that could not be scanned - reported, never fatal for the
   *  other providers. */
  providerErrors: Array<{ provider: string; error: string }>
  /** True when at least ONE provider's control plane was actually
   *  enumerated. False means "nothing was looked at" (no daemon, no
   *  provider configured, no `listBoxes`) - NOT "no orphan found". */
  scanned: boolean
  /** The providers that were NOT swept, and why. */
  notScanned: Array<{ provider: string; reason: string }>
  /** Boxes actually deleted (only with `apply`). */
  deleted: string[]
  /** Boxes whose delete failed (only with `apply`). */
  failed: Array<{ boxId: string; error: string }>
}

/**
 * One orphan-gc pass: scan every provider for orphan boxes and - with
 * `apply` - delete them (forced). Dry run by default.
 */
export async function runSandboxOrphanGcPass(
  deps: SandboxOrphanScanDeps & { apply?: boolean },
): Promise<SandboxOrphanGcPassResult> {
  const scans = await scanSandboxProviderOrphans(deps)
  const candidates = scans.flatMap(s => s.candidates)
  const providerErrors = scans
    .filter(s => s.error !== undefined)
    .map(s => ({ provider: s.provider, error: s.error as string }))
  const notScanned = scans
    .filter(s => !s.scanned)
    .map(s => ({ provider: s.provider, reason: s.skipped ?? s.error ?? "not scanned" }))
  const deleted: string[] = []
  const failed: Array<{ boxId: string; error: string }> = []
  if (deps.apply === true) {
    for (const candidate of candidates) {
      const res = await reapSandboxOrphan(candidate, {
        resolveProvider: deps.resolveProvider,
      })
      if (res.ok) deleted.push(candidate.boxId)
      else failed.push({ boxId: candidate.boxId, error: res.error })
    }
  }
  return {
    candidates,
    providerErrors,
    scanned: scans.some(s => s.scanned),
    notScanned,
    deleted,
    failed,
  }
}
