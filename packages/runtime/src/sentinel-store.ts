/**
 * SentinelStore — persists `~/.agentproto/sentinels.json` (AIP-60 §2).
 *
 * State is in-memory; sentinels persist to disk (debounced async write +
 * sync flush at shutdown), mirroring `inbound-endpoints.ts`'s
 * `InboundEndpointStore`. Unlike that store's `markSeen` (deliberately
 * in-memory only), dedup here is PERSISTED per sentinel, bounded to the last
 * 1000 event ids (design §2/§9) — a sentinel's dedup window must survive a
 * daemon restart, since the whole point of a sentinel is to keep watching
 * across restarts.
 *
 * Writes are atomic (write to a per-process tmp file, then rename), same
 * idiom as `sandbox-ledger.ts` — a crash mid-write must never leave a
 * corrupt `sentinels.json` behind.
 *
 * Secret-at-rest (W-B): a `webhook` target's signing secret never lives
 * inside the `Sentinel` record (whose `spec` is echoed verbatim by views) —
 * it is kept in a sidecar row keyed by an opaque `secretRef` handle,
 * persisted to `sentinels-secrets.json` next to `sentinels.json` with the
 * SAME 0600 plaintext-at-rest tradeoff every other credential store in this
 * runtime commits to (`handle.state`, `makeCredsStore` family files). Keys
 * are never logged; the delivery path is the only consumer of the sidecar.
 */

import { resolve, dirname, join } from "node:path"
import { homedir } from "node:os"
import { readFileSync, mkdirSync, writeFileSync, chmodSync, renameSync, promises as fsp } from "node:fs"
import { ulid } from "./app-state.js"
import type { SentinelHandle, SentinelSpec, SentinelTarget } from "./sentinel-providers/types.js"

// ── Types ─────────────────────────────────────────────────────────────

export type SentinelStatus = "active" | "paused" | "expired" | "orphaned" | "error"

export interface Sentinel {
  /** `sen_<ulid>`, daemon-minted. */
  id: string
  spec: SentinelSpec
  /** Resolved provider slug (never undefined once created, even when
   *  `spec.provider` was left for auto-select). */
  provider: string
  /** Opaque provider state (remote id, cursor, hook id, …). */
  handle: SentinelHandle
  status: SentinelStatus
  createdTs: number
  lastEventTs?: number
  eventCount: number
  lastError?: string
  /** Last `SEEN_CAP` event ids delivered/skipped for this sentinel — the
   *  dedup window (design §2: "last 1000 event ids, dedup across providers/
   *  restarts"). */
  seen: string[]
  /** For `spec.until.kind === "subject_terminal"` with more than one
   *  `spec.match` clause: the clause subjects that have already seen a
   *  terminal event. The sentinel only expires once every clause's subject
   *  is present here. Stays `[]` for other `until` kinds (unused) and for a
   *  single-clause spec is immediately superseded by expiry on that one
   *  clause's terminal event — same behaviour as before multi-clause
   *  `match` existed. */
  terminalSubjects: string[]
  /** Concrete event subjects (e.g. `github:o/r#12`) that have already seen a
   *  terminal event (PR merged/closed) — any later NON-terminal event for one
   *  of them is post-mortem noise (a check_suite failing after the merge) and
   *  is parked instead of delivered. Independent of `spec.until`. Absent on
   *  sentinels persisted before this field existed. */
  closedSubjects?: string[]
}

export interface SentinelCreateInput {
  /** Pre-minted id (see {@link mintSentinelId}); minted by the store when
   *  omitted. */
  id?: string
  spec: SentinelSpec
  provider: string
  handle: SentinelHandle
  status?: SentinelStatus
}

export type SentinelUpdatePatch = Partial<
  Pick<
    Sentinel,
    "spec" | "provider" | "handle" | "status" | "lastEventTs" | "eventCount" | "lastError" | "terminalSubjects" | "closedSubjects"
  >
>

/** Thrown by `SentinelStore.create` for a target kind that has no delivery
 *  implementation yet (`routine`) — the shape is frozen in
 *  {@link SentinelTarget} so callers/tools can reference the full union, but
 *  creation is refused until a later step wires actual delivery. */
export class SentinelTargetNotImplementedError extends Error {
  readonly kind: string
  constructor(kind: string) {
    super(`sentinel target kind "${kind}" is not implemented yet (not_implemented)`)
    this.name = "SentinelTargetNotImplementedError"
    this.kind = kind
  }
}

/** A `webhook` target's secret sidecar row — the material `signWebhook` and
 *  challenge verification need, keyed by the `secretRef` the at-rest target
 *  carries. The material NEVER sits inside the `Sentinel` record or any
 *  sentinel view (plan §4 W-B task 4); keys are never logged. */
export interface SentinelWebhookSecret {
  /** Current signing secret (`whsec_…`, standard-base64 wire format). */
  secret: string
  /** Previous secret — kept while a rotation window is open (10 min from
   *  `rotatedAt`) so delivery signs with BOTH during renewal. */
  prevSecret?: string
  /** Wall-clock ms at which `prevSecret` was superseded by `secret`; the
   *  dual-sign window is `now - rotatedAt < 10 minutes`. */
  rotatedAt?: number
}

/** What {@link SentinelStore.putSentinelSecret} hands back — the only thing
 *  sidecar writes return; never the material. */
export interface SentinelSecretWriteResult {
  ref: string
  hasPrevSecret: boolean
  rotatedAt?: number
}

/** The AT-REST shape of a `webhook` target (plan §4 W-B task 4): the raw
 *  `secret` the caller submitted lives in the secret sidecar under
 *  `secretRef` and is substituted OUT of the spec at the record boundary —
 *  a raw secret is never inside a `Sentinel` record or a sentinel view. The
 *  public {@link SentinelTarget} union still declares `{url, secret}` (AIP-60
 *  §2); the union itself grows `secretRef` with W-C's spec pass, until which
 *  the persistence here carries a documented structural narrow cast. */
export interface SentinelWebhookTargetAtRest {
  kind: "webhook"
  url: string
  secretRef: string
}

export interface SentinelStore {
  get(id: string): Sentinel | undefined
  list(): Sentinel[]
  create(input: SentinelCreateInput): Sentinel
  update(id: string, patch: SentinelUpdatePatch): Sentinel | undefined
  remove(id: string): boolean
  /** true = first time this event id has been seen for this sentinel
   *  (persisted dedup, bounded). Returns true (treat-as-unseen) for an
   *  unknown sentinel id — never blocks a caller who already validated the
   *  sentinel exists moments earlier.
   *
   *  Callers that need at-least-once delivery MUST check {@link isSeen}
   *  BEFORE attempting delivery and only call `markSeen` AFTER delivery is
   *  handled (delivered or parked) — calling this before delivery and
   *  bailing out on a thrown error would dedupe the event out of every
   *  future redelivery attempt, silently losing it. */
  markSeen(id: string, eventId: string): boolean
  /** Read-only check: true = this event id is already in the persisted
   *  `seen` window for this sentinel. Never mutates — use this to decide
   *  whether an event needs (re)delivery, and only call `markSeen` once
   *  delivery has actually been handled. Returns false for an unknown
   *  sentinel id (nothing recorded, so nothing has been "seen"). */
  isSeen(id: string, eventId: string): boolean
  /** Write a webhook secret sidecar row (secret material at rest, 0600
   *  sidecar file, keys never logged). When the row's existing `secret`
   *  DIFFERS, the old one is kept as `prevSecret` and `rotatedAt` is
   *  stamped now — the dual-sign window arithmetic lives on the delivery
   *  side. Returns only non-secret metadata; never the secret. */
  putSentinelSecret(ref: string, row: SentinelWebhookSecret): SentinelSecretWriteResult | undefined
  /** Read a secret sidecar row (delivery path only — never a listing path). */
  getSentinelSecret(ref: string): SentinelWebhookSecret | undefined
  /** Read-only expiry consultation for `until: {kind:"at"}` — false for
   *  every other `until` kind and for an unknown id. Sweeping the status
   *  flip belongs to the runtime; this never mutates. */
  isExpired(id: string): boolean
  /** Solve the `secretRef` for a webhook target: a target still carrying
   *  raw `secret` has it moved into the sidecar (fresh ref returned); a
   *  target already carrying `secretRef` (at-rest shape) is left as-is and
   *  its ref returned. undefined = not a webhook target, or neither
   *  secret nor ref present. */
  materializeWebhookTargetRef(target: SentinelTarget): string | undefined
  /** Synchronous flush for shutdown paths. */
  flushSync(): void
}

// ── Constants ─────────────────────────────────────────────────────────

/** Respects the daemon's configured home dir override, same expression as
 *  `transcript-export.ts`'s `mastracodeInprocessDbPath` / the provider-kit
 *  `resolveHome` helper. */
function agentprotoHome(): string {
  return process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto")
}

export const SENTINELS_FILE_PATH = (): string => resolve(agentprotoHome(), "sentinels.json")

/** The webhook secret sidecar file, next to the main store file. */
export const sentinelsSecretsFileFor = (filePath: string): string =>
  resolve(dirname(filePath), "sentinels-secrets.json")

/** Dual-sign rotation window: both secrets sign while within 10 min of
 *  `rotatedAt` (plan §4 W-B task 4 — the row shape lands here; the delivery
 *  side computes the window from `rotatedAt`). */
export const WEBHOOK_SECRET_ROTATION_WINDOW_MS = 10 * 60 * 1000

const PERSIST_DEBOUNCE_MS = 1_500

/** Per-sentinel cap for the persisted dedup window (design §2). */
const SEEN_CAP = 1_000

let tmpSeq = 0

/** `sen_<ulid>` — minted before provider `create` when the provider needs to
 *  stamp the id remotely, then passed to `SentinelStore.create({id})`. */
export function mintSentinelId(nowMs: number = Date.now()): string {
  return `sen_${ulid(nowMs)}`
}

/** Only `routine` is still frozen (AIP-41 event binding, out of W-B scope);
 *  `session` and `webhook` both have delivery implementations. */
function assertTargetImplemented(target: SentinelTarget): void {
  if (target.kind === "routine") {
    throw new SentinelTargetNotImplementedError(target.kind)
  }
}

/** The at-rest denaturing: `{kind:"webhook", url, secretRef}`. The public
 *  union still declares `{url, secret}` (AIP-60 §2), so the record boundary
 *  narrows with a documented structural cast until the W-C spec pass widens
 *  the union. */
const toAtRestWebhookTarget = (target: {
  kind: "webhook"
  url: string
  secretRef: string
}): SentinelTarget => target as unknown as SentinelTarget

// ── Factory ───────────────────────────────────────────────────────────

export interface SentinelStoreOptions {
  /** Override persist path. Default ~/.agentproto/sentinels.json (or
   *  AGENTPROTO_HOME/sentinels.json). */
  filePath?: string
  /** Override the webhook secret sidecar path. Default
   *  `sentinels-secrets.json` next to `filePath`. */
  secretsFilePath?: string
  /** Injectable clock for tests. */
  nowMs?: () => number
  /** Debounce interval for disk persistence. */
  debounceMs?: number
  /** Disable disk persistence (unit tests). Default false, unless filePath
   *  is set (mirrors InboundEndpointStore's convention). */
  persist?: boolean
}

export function createSentinelStore(opts?: SentinelStoreOptions): SentinelStore {
  const filePath = opts?.filePath ?? SENTINELS_FILE_PATH()
  const secretsFilePath = opts?.secretsFilePath ?? sentinelsSecretsFileFor(filePath)
  const nowMs = opts?.nowMs ?? Date.now
  const debounceMs = opts?.debounceMs ?? PERSIST_DEBOUNCE_MS
  const persist = opts?.persist ?? opts?.filePath !== undefined

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let secretsPersistTimer: ReturnType<typeof setTimeout> | null = null

  // ── Load-on-construct ────────────────────────────────────────────────

  const load = (): Map<string, Sentinel> => {
    const out = new Map<string, Sentinel>()
    if (!persist) return out
    let raw: string
    try {
      raw = readFileSync(filePath, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[sentinel-store] read failed, starting empty: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return out
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, Sentinel>
      for (const [id, sentinel] of Object.entries(parsed)) out.set(id, sentinel)
    } catch (err) {
      console.warn(
        `[sentinel-store] corrupt file, starting empty: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return out
  }

  const sentinels = load()

  const loadSecrets = (): Map<string, SentinelWebhookSecret> => {
    const out = new Map<string, SentinelWebhookSecret>()
    if (!persist) return out
    let raw: string
    try {
      raw = readFileSync(secretsFilePath, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[sentinel-store] secret sidecar read failed, starting empty: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return out
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, SentinelWebhookSecret>
      for (const [ref, row] of Object.entries(parsed)) out.set(ref, row)
    } catch (err) {
      console.warn(
        `[sentinel-store] corrupt secret sidecar, starting empty: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return out
  }

  const secrets = loadSecrets()

  // ── Persistence (atomic tmp+rename, mirrors sandbox-ledger.ts) ───────

  const snapshot = (): Record<string, Sentinel> => {
    const out: Record<string, Sentinel> = {}
    for (const [id, sentinel] of sentinels.entries()) out[id] = sentinel
    return out
  }

  const secretsSnapshot = (): Record<string, SentinelWebhookSecret> => {
    const out: Record<string, SentinelWebhookSecret> = {}
    for (const [ref, row] of secrets.entries()) out[ref] = row
    return out
  }

  const schedulePersist = (): void => {
    if (!persist) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void (async () => {
        try {
          const snap = snapshot()
          await fsp.mkdir(dirname(filePath), { recursive: true })
          const tmp = `${filePath}.tmp.${process.pid}.${++tmpSeq}`
          // mode 0600 -- a sentinel's handle can carry a provider secret
          // (e.g. a webhook hook id / cursor token), same tradeoff as every
          // other credential-adjacent store in this runtime.
          await fsp.writeFile(tmp, JSON.stringify(snap, null, 2) + "\n", { mode: 0o600 })
          await fsp.chmod(tmp, 0o600)
          await fsp.rename(tmp, filePath)
        } catch (err) {
          console.warn(
            `[sentinel-store] persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })()
    }, debounceMs)
  }

  /** Same debounced/atomic idiom as the main file — the sidecar is a second
   *  0600 file in the same directory. */
  const scheduleSecretsPersist = (): void => {
    if (!persist) return
    if (secretsPersistTimer) clearTimeout(secretsPersistTimer)
    secretsPersistTimer = setTimeout(() => {
      void (async () => {
        try {
          await fsp.mkdir(dirname(secretsFilePath), { recursive: true })
          const tmp = `${secretsFilePath}.tmp.${process.pid}.${++tmpSeq}`
          await fsp.writeFile(tmp, JSON.stringify(secretsSnapshot(), null, 2) + "\n", { mode: 0o600 })
          await fsp.chmod(tmp, 0o600)
          await fsp.rename(tmp, secretsFilePath)
        } catch (err) {
          console.warn(
            `[sentinel-store] secret sidecar persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })()
    }, debounceMs)
  }

  const flushSync = (): void => {
    if (!persist) return
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (secretsPersistTimer) {
      clearTimeout(secretsPersistTimer)
      secretsPersistTimer = null
    }
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp.${process.pid}.${++tmpSeq}`
      writeFileSync(tmp, JSON.stringify(snapshot(), null, 2) + "\n", { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, filePath)
      mkdirSync(dirname(secretsFilePath), { recursive: true })
      const tmpSecrets = `${secretsFilePath}.tmp.${process.pid}.${++tmpSeq}`
      writeFileSync(tmpSecrets, JSON.stringify(secretsSnapshot(), null, 2) + "\n", { mode: 0o600 })
      chmodSync(tmpSecrets, 0o600)
      renameSync(tmpSecrets, secretsFilePath)
    } catch {
      // best-effort — never throw in the shutdown path
    }
  }

  // ── At-rest denaturing (webhook targets) ─────────────────────────────

  /** Pull a submitted raw `secret` out of a `webhook` target into the
   *  sidecar; hand back the denatured spec. A target already carrying a
   *  `secretRef` (at-rest round-trip, e.g. through an update) is left
   *  untouched. */
  const denatureWebhookTarget = (spec: SentinelSpec): SentinelSpec => {
    const target = spec.target
    if (target.kind !== "webhook") return spec
    const t = target as SentinelTarget & { secret?: string; secretRef?: string }
    if (typeof t.secretRef === "string" && t.secretRef.length > 0) return spec
    if (typeof t.secret === "string" && t.secret.length > 0) {
      const secretRef = `swsec_${ulid(nowMs())}`
      secrets.set(secretRef, { secret: t.secret })
      scheduleSecretsPersist()
      return { ...spec, target: toAtRestWebhookTarget({ kind: "webhook", url: target.url, secretRef }) }
    }
    throw new Error('sentinel target "webhook" is missing its signing secret (not_implemented)')
  }

  // ── Public interface ────────────────────────────────────────────────

  return {
    get(id: string): Sentinel | undefined {
      return sentinels.get(id)
    },

    list(): Sentinel[] {
      return Array.from(sentinels.values())
    },

    create(input: SentinelCreateInput): Sentinel {
      assertTargetImplemented(input.spec.target)
      const spec = denatureWebhookTarget(input.spec)
      const id = input.id ?? mintSentinelId(nowMs())
      const sentinel: Sentinel = {
        id,
        spec,
        provider: input.provider,
        handle: input.handle,
        status: input.status ?? "active",
        createdTs: nowMs(),
        eventCount: 0,
        seen: [],
        terminalSubjects: [],
        closedSubjects: [],
      }
      sentinels.set(id, sentinel)
      schedulePersist()
      return sentinel
    },

    update(id: string, patch: SentinelUpdatePatch): Sentinel | undefined {
      const existing = sentinels.get(id)
      if (!existing) return undefined
      // A patch that swaps in a webhook target carrying raw secret material
      // goes through the same sidecar denaturing as create (rotation path).
      const next: Sentinel = {
        ...existing,
        ...patch,
        ...(patch.spec !== undefined ? { spec: denatureWebhookTarget(patch.spec) } : {}),
      }
      sentinels.set(id, next)
      schedulePersist()
      return next
    },

    remove(id: string): boolean {
      const sentinel = sentinels.get(id)
      if (sentinel?.spec.target.kind === "webhook") {
        // The secret sidecar row dies with its sentinel — no orphaned material.
        if (secrets.delete((sentinel.spec.target as SentinelWebhookTargetAtRest).secretRef)) {
          scheduleSecretsPersist()
        }
      }
      const existed = sentinels.delete(id)
      if (existed) schedulePersist()
      return existed
    },

    isSeen(id: string, eventId: string): boolean {
      const sentinel = sentinels.get(id)
      if (!sentinel) return false
      return sentinel.seen.includes(eventId)
    },

    markSeen(id: string, eventId: string): boolean {
      const sentinel = sentinels.get(id)
      if (!sentinel) return true
      if (sentinel.seen.includes(eventId)) return false
      const nextSeen = [...sentinel.seen, eventId]
      if (nextSeen.length > SEEN_CAP) nextSeen.splice(0, nextSeen.length - SEEN_CAP)
      sentinels.set(id, { ...sentinel, seen: nextSeen })
      schedulePersist()
      return true
    },

    putSentinelSecret(ref: string, row: SentinelWebhookSecret): SentinelSecretWriteResult | undefined {
      const existing = secrets.get(ref)
      const next: SentinelWebhookSecret =
        existing && existing.secret !== row.secret
          ? { secret: row.secret, prevSecret: existing.secret, rotatedAt: nowMs() }
          : { ...existing, ...row }
      secrets.set(ref, next)
      scheduleSecretsPersist()
      const rotatedAt = next.rotatedAt
      return {
        ref,
        hasPrevSecret: next.prevSecret !== undefined,
        ...(rotatedAt !== undefined ? { rotatedAt } : {}),
      }
    },

    getSentinelSecret(ref: string): SentinelWebhookSecret | undefined {
      return secrets.get(ref)
    },

    isExpired(id: string): boolean {
      const sentinel = sentinels.get(id)
      if (!sentinel) return false
      return sentinel.spec.until.kind === "at" ? nowMs() >= sentinel.spec.until.ms : false
    },

    materializeWebhookTargetRef(target: SentinelTarget): string | undefined {
      if (target.kind !== "webhook") return undefined
      const t = target as SentinelTarget & { secret?: string; secretRef?: string }
      if (typeof t.secretRef === "string" && t.secretRef.length > 0) return t.secretRef
      if (typeof t.secret === "string" && t.secret.length > 0) {
        const secretRef = `swsec_${ulid(nowMs())}`
        secrets.set(secretRef, { secret: t.secret })
        scheduleSecretsPersist()
        return secretRef
      }
      return undefined
    },

    flushSync,
  }
}
