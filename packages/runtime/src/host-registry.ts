/**
 * Daemon-side HOST registry (DEVICES-PLAN PR-C) — the "client" half of
 * pair/v2, living on the daemon so it's reachable over both an HTTP route
 * and an MCP tool, not just CLI-local bookkeeping (`client-pairings.ts` /
 * `pair-transport.ts` are that CLI-local equivalent today).
 *
 * Where `pairing-registry.ts` is what a daemon uses to let OTHER machines
 * pair with and remote-control IT, `host-registry.ts` is what a daemon uses
 * to register and drive OTHER daemons — reverse pairing. `add()` accepts a
 * HOST-scoped offer (`agentproto pair offer --host`, offer-url.ts's
 * `scope`), runs the pair/v2 client handshake, and persists the resulting
 * pair root; `forwardHttp()` dials on demand, reconnecting over the current
 * (then previous) epoch token exactly like `pair-transport.ts`'s
 * `openPairChannel`, forwards one HTTP request over the resulting tunnel
 * client, and closes. There is no standing connection here — unlike
 * `PairingRegistry`, a `HostRegistry` never autoconnects or keeps a
 * reconnect loop parked at the broker; every reach-out is a fresh dial.
 * That also means shutdown needs no teardown: there is nothing standing to
 * tear down.
 *
 * ## The scope gate
 *
 * `add()` REFUSES (throws) any offer whose parsed `scope !== "host"` before
 * ever dialing anything. This is the default-deny gate PR-C exists to add:
 * an ordinary "remote-control me" offer (today's `pair offer`, no `--host`)
 * must not silently become a host registration, even though the underlying
 * wire capability is identical either way (see offer-url.ts's "Offer scope"
 * and pairing-registry.ts's `OfferEntry.scope` doc comment for why the
 * offering daemon's OWN server-side record — not the URL's plaintext
 * `scope` param — is what's authoritative about what it granted). There is
 * deliberately no override flag.
 *
 * Persisted to `hosts.json` (`~/.agentproto/hosts.json` by default) with the
 * same atomic-write discipline as `pairings.json` (mkdir, write to a
 * pid-keyed tmp file at 0600, chmod, rename) and the same lazy-load-on-
 * first-use pattern.
 *
 * ## Online tracking
 *
 * `isOnline(fingerprint)` is true while a `forwardHttp()` call for that
 * fingerprint is in flight (a reference count, incremented on dial and
 * decremented in a `finally`), OR within `onlineGraceMs` of the last time a
 * dial to it actually succeeded (an `add()` handshake, a `forwardHttp`, or a
 * background snapshot poll). There is no live probe backing `list()` — that
 * would make `devices list` slow/flaky over N hosts — so a host answering
 * every ~15s snapshot poll stays online, and one that stops answering
 * decays to offline after the grace window. Every contact attempt stamps
 * `lastProbeAt`; a failed one records `lastError` (cleared by the next success).
 *
 * ## Proactive session snapshots
 *
 * A join-token-added host (an ephemeral CI runner) lives ~3 minutes, far
 * shorter than anyone watches it. So from the moment such a host joins, this
 * registry polls it (`snapshotIntervalMs`, faster while one of its sessions
 * is running) for its session list plus a capped output tail per session and
 * keeps the result in memory. Once the host is offline, `getSessionsSnapshot`
 * serves that — `stale: true` with the capture time. After
 * `snapshotMaxFailures` consecutive unreachable polls the loop backs off
 * exponentially (up to `probeBackoffMaxMs`) and keeps the last good capture;
 * `start()` resumes the loop for every join-added host after a daemon
 * restart, and background probes share a `probeConcurrency` cap.
 * `snapshotNow()` lets a departing host trigger one last
 * capture (see `join-token-registry.ts`'s goodbye hello).
 *
 * ## Ended hosts
 *
 * A join-added host is an ephemeral CI box, so it is marked `ended` when its
 * goodbye arrives (`markEnded`) or when it has been unreachable for
 * `endedTtlMs` (2 h), and deleted `endedRetentionMs` (7 d) after that.
 * `sweep()` runs that pass (the daemon calls it on a timer; `list()` runs it
 * too). Ended hosts are still returned by `list()` — hiding them from the
 * default `device_list` is `device-registry.ts`'s job. A manually added host
 * is never ended or deleted; `list()` only flags it `stale`.
 */

import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { dirname, join, basename } from "node:path"
import {
  createTunnelClient,
  clientHandshakeOverSink,
  type FrameSink,
  type TunnelClient,
  type TunnelHttpRequest,
  type TunnelHttpStreamResponse,
} from "@agentproto/acp/tunnel"
import {
  startClientHandshake,
  encodePairingMessage,
  decodePairingReply,
  parseOfferUrl,
  derivePairRoot,
  deriveEpochTokens,
  deriveOfferTokens,
  currentEpoch,
  PAIRING_PROTOCOL_OUTDATED_MESSAGE,
  type PairingSession,
} from "@agentproto/secrets/pairing"

/** `hosts.json` format. */
export const HOSTS_VERSION = 1 as const

const DIAL_TIMEOUT_MS = 15_000
const HANDSHAKE_TIMEOUT_MS = 15_000
/** Default unreachable-for window after which a join-added host is marked
 *  ended — see `HostRegistryDeps.endedTtlMs`. */
const DEFAULT_ENDED_TTL_MS = 2 * 3_600_000
/** Default time an ended host is kept before deletion — see
 *  `HostRegistryDeps.endedRetentionMs`. */
const DEFAULT_ENDED_RETENTION_MS = 7 * 86_400_000
/** Cap on distinct `/sessions*` paths cached per host (list + however many
 *  individual sessions' output have actually been queried) — bounds memory
 *  for a host with many short-lived sessions; oldest-cached path evicted
 *  first. */
const MAX_CACHED_SESSION_PATHS_PER_HOST = 32
/** How long after the last successful dial a host still reads `online`. */
const DEFAULT_ONLINE_GRACE_MS = 120_000
/** Ceiling of the poll backoff once a host has failed `snapshotMaxFailures` probes in a row. */
const DEFAULT_PROBE_BACKOFF_MAX_MS = 300_000
/** Background probes allowed in flight across all hosts at once. */
const DEFAULT_PROBE_CONCURRENCY = 4
/** Gap between the first polls of hosts resumed at boot, so a long list doesn't dial in one burst. */
const RESUME_STAGGER_MS = 500
const MAX_LAST_ERROR_CHARS = 300
/** Consecutive failed dial/handshake attempts after which the daemon logs
 *  the re-pair remediation hint (BOOTSTRAP P3 item 4, WIN11 field test
 *  2026-09-30: after a Windows reboot the old host registration never
 *  handshook again, and the controller's log showed nothing actionable
 *  until the operator revoked and re-added). */
const HOST_HANDSHAKE_FAILURE_HINT_THRESHOLD = 5
/** One-line remediation logged once per failure streak once the threshold
 *  is crossed. Deliberately NOT a protocol change — the pairing itself is
 *  fine; a fresh host-scoped offer re-binds it. */
export const HOST_HANDSHAKE_REMEDIATION_HINT =
  "host handshake failing — the controller should re-run `agentproto devices add` " +
  "with a fresh `pair offer --host` (a reboot/reinstall on the host invalidates the old registration)"
/** Consecutive failed dials per host fingerprint — reset on a successful
 *  dial, never persisted (diag-only, dies with the process). */
const handshakeFailures = new Map<string, number>()
/** Minimum gap between `hosts.json` writes for a pure `lastSeen` bump. */
const DEFAULT_LAST_SEEN_PERSIST_MS = 30_000
const DEFAULT_SNAPSHOT_INTERVAL_MS = 15_000
/** Poll cadence while any snapshotted session is `running`/`starting`. */
const DEFAULT_SNAPSHOT_ACTIVE_INTERVAL_MS = 5_000
const DEFAULT_SNAPSHOT_MAX_FAILURES = 3
const SNAPSHOT_REQUEST_TIMEOUT_MS = 10_000
/** Output lines captured per session (the daemon's own `lastN` ceiling is 500). */
const SNAPSHOT_OUTPUT_LINES = 200
/** Sessions captured per host, most recently active first. */
const SNAPSHOT_MAX_SESSIONS = 20
/** Cap on a single cached response body — `device_sessions`'s own `lastN`
 *  already caps line count (max 500), so this is a defensive ceiling, not
 *  the primary control. */
const MAX_CACHED_SESSION_BODY_BYTES = 256 * 1024

/** One persisted host — a daemon this daemon can drive. */
export interface HostRecord {
  /** The target daemon's identity fingerprint (32 hex). */
  fingerprint: string
  /** Human-facing label; defaults to the fingerprint. */
  name: string
  /** Target daemon's static X25519 public key, standard base64 SPKI DER —
   *  pinned at `add()` time. */
  daemonX25519Pub: string
  /** Target daemon's static Ed25519 public key, standard base64 SPKI DER —
   *  pinned at `add()` time. */
  daemonEd25519Pub: string
  /** Rendezvous endpoint to reach the host through. */
  rendezvousUrl: string
  /** Long-term shared secret (base64), from which epoch routing tokens
   *  derive — same derivation as `PairingRecord.pairRoot`. */
  pairRoot: string
  /** ISO-8601 first-add timestamp. */
  createdAt: string
  /** ISO-8601 of the most recent successful contact (join, dial, background poll). */
  lastSeen: string
  /** ISO-8601 of the most recent contact attempt, successful or not. Not
   *  persisted on every attempt — it rides along with the next write. */
  lastProbeAt?: string
  /** Why the most recent contact attempt failed; cleared by the next success. */
  lastError?: string
  /** A join-added host that is gone: it said goodbye, or was unreachable for
   *  longer than `endedTtlMs`. Ended hosts are no longer polled, read offline,
   *  and are deleted `endedRetentionMs` after `endedAt`. Never set on a
   *  manually added host. */
  ended?: true
  /** ISO-8601 of when the host ended (for a TTL end: when the TTL lapsed, not
   *  when the sweep noticed). */
  endedAt?: string
  endReason?: "goodbye" | "ttl"
  /** Computed by `list()`, never persisted: a manually added host that has
   *  been unreachable for longer than `endedTtlMs`. Stale hosts stay listed
   *  and are never deleted — only join-added hosts are. */
  stale?: true
  /** Set on a host added under the retired pair/v1 protocol. Present for
   *  parity with `PairingRecord`/`ClientPairing`; pair/v1 offers are refused
   *  by `parseOfferUrl` before `add()` ever sees them, so this is currently
   *  unreachable — kept so a future downgrade path has somewhere to flag it. */
  legacy?: true
  /** Self-reported by the host at add-time (SANDBOX-VISIBILITY-JOIN) — e.g. a
   *  sandbox provider slug, a provider-side sandbox id, and free-form labels
   *  (PR number, run URL, …). Never verified beyond "the host said so"; purely
   *  descriptive for `device_list`/`devices sessions`. */
  provider?: string
  sandboxId?: string
  labels?: Record<string, string>
  /**
   * How this host got here (SANDBOX-VISIBILITY-JOIN #3) — `"join"` for a
   * box that dialed in via `AGENTPROTO_JOIN`/`join-token-registry.ts`,
   * `"manual"` for the human `pair offer --host` + `devices add` ceremony.
   * Absent on a record persisted before this field existed; treated as
   * `"manual"` (never auto-pruned) rather than assumed ephemeral. Only
   * `"join"` hosts are eligible for the ended/retention sweep — a human's
   * own paired machine must never silently disappear just because it hasn't
   * been dialed in a week.
   */
  addedVia?: "join" | "manual"
}

/** Optional self-reported metadata `add()` attaches to the resulting
 *  `HostRecord` (see `HostRecord.provider`/`sandboxId`/`labels`). */
export interface HostJoinMeta {
  provider?: string
  sandboxId?: string
  labels?: Record<string, string>
  /** Set by `join-token-registry.ts`'s `handleJoined()` — never by a manual
   *  `device_add`/`devices add` call — so `add()` can tell a join-token box
   *  apart from a human's own paired host (see `HostRecord.addedVia`). */
  joined?: true
}

interface HostsFile {
  v: typeof HOSTS_VERSION
  hosts: HostRecord[]
}

export interface HostRegistryDeps {
  /** Dial a rendezvous WS and adapt it to a `FrameSink`. Same shape as
   *  `PairingRegistryDeps.dial` — the CLI's `daemonDialRendezvous` satisfies
   *  it directly. Rejects if the dial fails or `signal` aborts. */
  dial: (wsUrl: string, signal: AbortSignal) => Promise<FrameSink>
  /** Path to `hosts.json`. Defaults to `~/.agentproto/hosts.json`. */
  hostsPath?: string
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number
  /** Diagnostic log sink. */
  log?: (line: string) => void
  /** Rendezvous dial ceiling per attempt. Default 15s. */
  dialTimeoutMs?: number
  /** Handshake ceiling per attempt. Default 15s. */
  handshakeTimeoutMs?: number
  /**
   * A join-added host (`HostRecord.addedVia === "join"`) unreachable for this
   * long (ms since `lastSeen`) is marked `ended`. Default 2 h; `0` disables.
   * Manually added hosts are never ended — `list()` only flags them `stale`.
   */
  endedTtlMs?: number
  /**
   * An ended host is deleted this long (ms) after `endedAt`. Default 7 days;
   * `0` keeps ended hosts forever. Only join-added hosts are ever deleted.
   */
  endedRetentionMs?: number
  /** Cadence (ms) of the proactive session snapshot poll for a join-added
   *  host. Default 15s; `0` disables the poll (and `snapshotNow` becomes a
   *  no-op that returns false). */
  snapshotIntervalMs?: number
  /** Faster cadence used while a snapshotted session is running. Default 5s. */
  snapshotActiveIntervalMs?: number
  /** Consecutive unreachable polls before the poll starts backing off. Default 3. */
  snapshotMaxFailures?: number
  /** A host stays `online` for this long after a successful dial. Default 2 min. */
  onlineGraceMs?: number
  /** Consecutive-failure poll backoff ceiling (ms). Default 5 min. */
  probeBackoffMaxMs?: number
  /** Max background probes in flight across all hosts. Default 4. */
  probeConcurrency?: number
  /** Min gap between disk writes for a `lastSeen`-only change. Default 30s. */
  lastSeenPersistIntervalMs?: number
}

export interface ForwardHttpRequest {
  method: string
  path: string
  headers?: Record<string, string>
  body?: Uint8Array
}

export interface ForwardHttpResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
  /** Set when this response was served from the last-known-good `/sessions*`
   *  cache instead of a live forward (SANDBOX-VISIBILITY-JOIN #3) — see
   *  {@link HostRegistry.getSessionsSnapshot}. Absent on every live
   *  response, including `forwardHttp` itself, which never sets it — only
   *  the cache fallback in `device-registry.ts` does. */
  stale?: true
  /** ISO-8601 capture time of a `stale` response. */
  capturedAt?: string
}

/** A cache entry — always has both `stale`/`capturedAt` set, unlike its
 *  parent `ForwardHttpResponse` where they're optional. */
interface CachedForwardHttpResponse extends ForwardHttpResponse {
  stale: true
  capturedAt: string
}

/** One session's captured output tail — the parsed `GET /sessions/:id/output`
 *  body (`{ sessionId, status, lines, … }`). */
interface CapturedOutput {
  capturedAt: string
  body: Record<string, unknown> & { lines: string[] }
}

/** A proactive capture of a host's sessions (see the module doc). */
interface HostSnapshot {
  capturedAt: string
  listStatus: number
  listHeaders: Record<string, string>
  listBody: Uint8Array
  outputs: Map<string, CapturedOutput>
}

/** Streaming counterpart of {@link ForwardHttpResponse} — `body` is a Web
 *  `ReadableStream` the caller drains directly (SSE chat/completions, most
 *  notably) instead of a fully-buffered `Uint8Array`. See
 *  {@link HostRegistry.forwardHttpStream}. */
export interface ForwardHttpStreamResponse {
  status: number
  headers: Record<string, string>
  body: ReadableStream<Uint8Array>
}

export interface HostRegistry {
  /**
   * Accept an offer URL and register the target daemon as a driveable host.
   * REFUSES (throws a plain `Error`) unless the parsed offer has
   * `scope === "host"` — no dial is attempted in that case. Otherwise: dials
   * the offer's rendezvous, runs the pair/v2 client handshake, verifies the
   * derived peer fingerprint matches the offer's `id` (defence in depth,
   * mirrors `pair-transport.ts`'s `acceptOffer`), derives the pair root, and
   * persists a `HostRecord` (upserted by fingerprint — re-adding replaces).
   */
  add(
    offerUrl: string,
    name?: string,
    meta?: HostJoinMeta,
  ): Promise<{ fingerprint: string; name: string; rendezvousUrl: string }>
  /** All persisted hosts (copies). Loads `hosts.json` on first call. */
  list(): Promise<HostRecord[]>
  /** Rename a host (fingerprint or current name). Returns false when nothing
   *  matched; throws on an empty `newName`. */
  rename(idOrName: string, newName: string): Promise<boolean>
  /** Drop a host by fingerprint or name. Returns false when nothing matched. */
  revoke(idOrName: string): Promise<boolean>
  /** Is a `forwardHttp` call for this fingerprint in flight right now? */
  isOnline(fingerprint: string): boolean
  /**
   * On-demand: dial the host, run the client handshake against the current
   * epoch's tokens (falling back to the previous epoch, bridging clock
   * skew — same two-attempt shape as `pair-transport.ts`'s
   * `openPairChannel`), forward one HTTP request over the resulting tunnel
   * client, then close. Throws with a re-pair hint if every attempt hangs up
   * on the hello (likely a pair/v1 peer).
   */
  forwardHttp(idOrName: string, req: ForwardHttpRequest): Promise<ForwardHttpResponse>
  /**
   * Same dial/handshake/retry shape as {@link forwardHttp}, but for a
   * streamed response (SSE, NDJSON, long-poll) — the daemon-inference proxy's
   * `/v1/chat/completions` most notably, which must relay tokens as they
   * arrive rather than buffering the whole completion first. Unlike
   * `forwardHttp`, the tunnel client is kept open (and `isOnline` stays true)
   * until the returned `body` stream is fully drained, errors, or is
   * cancelled — only then does it close and the online count drop.
   */
  forwardHttpStream(idOrName: string, req: ForwardHttpRequest): Promise<ForwardHttpStreamResponse>
  /**
   * The last-known-good response for a GET `/sessions` or
   * `/sessions/:id/output...` request against this host, captured the last
   * time {@link forwardHttp} actually reached it — or `undefined` if this
   * host has never answered that exact path, or isn't known at all. Always
   * `stale: true` (a live hit never goes through this method — callers
   * should try {@link forwardHttp} first and only fall back to this on
   * failure, which is exactly what `device-registry.ts`'s `forwardHttp`
   * wrapper does). In-memory only — see host-registry.ts's module doc for
   * why that's an acceptable trade here.
   */
  getSessionsSnapshot(idOrName: string, path: string): ForwardHttpResponse | undefined
  /**
   * Capture this host's session list + output tails right now (the same
   * capture the background poll takes). Resolves true when the host was
   * reached. Never throws; false for an unknown host, an unreachable one, or
   * when snapshots are disabled.
   */
  snapshotNow(idOrName: string): Promise<boolean>
  /**
   * Mark a join-added host ended right now (its CI job said goodbye). Stops
   * its poll. Returns false for an unknown host or a manually added one,
   * which is never ended. Idempotent.
   */
  markEnded(idOrName: string, reason?: "goodbye" | "ttl"): Promise<boolean>
  /**
   * Run the lifecycle sweep now: mark join-added hosts ended past `endedTtlMs`,
   * delete those ended past `endedRetentionMs`, persist if anything changed.
   * Cheap (one pass over the in-memory map); `list()` runs the same pass.
   */
  sweep(): Promise<void>
  /**
   * Load `hosts.json` and resume the background poll for every join-added
   * host, so a daemon restart doesn't leave still-running CI boxes frozen at
   * their join-time `lastSeen`. Idempotent; call once at boot.
   */
  start(): Promise<void>
}

function defaultHostsPath(): string {
  return join(homedir(), ".agentproto", "hosts.json")
}

/** `/sessions` or `/sessions/...` exactly — not a loose prefix match, so a
 *  hypothetical future `/sessions-admin/...` route (or similar) is never
 *  mistaken for one of these read-only, cacheable-and-stale-fallback-able
 *  paths. Shared by `cacheSessionsResponse` here and `device-registry.ts`'s
 *  `forwardHttp` fallback gate — both must agree on exactly which paths this
 *  applies to. */
export function isSessionsPath(path: string): boolean {
  return path === "/sessions" || path.startsWith("/sessions/") || path.startsWith("/sessions?")
}

/** Broker upgrade URL. `route` must be a ROUTE token — never an auth token or
 *  the offer secret: everything here is visible to the broker. Mirrors
 *  `pair-transport.ts`'s `rvUrl` / `pairing-registry.ts`'s `dialUrl`. */
function rvUrl(base: string, route: string): string {
  const sep = base.includes("?") ? "&" : "?"
  return `${base}${sep}side=client&t=${encodeURIComponent(route)}`
}

function defaultSelfName(): string {
  try {
    return hostname() || "agentproto-host-registry"
  } catch {
    return "agentproto-host-registry"
  }
}

export function createHostRegistry(deps: HostRegistryDeps): HostRegistry {
  const hostsPath = deps.hostsPath ?? defaultHostsPath()
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const dialTimeoutMs = deps.dialTimeoutMs ?? DIAL_TIMEOUT_MS
  const handshakeTimeoutMs = deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
  const endedTtlMs = deps.endedTtlMs ?? DEFAULT_ENDED_TTL_MS
  const endedRetentionMs = deps.endedRetentionMs ?? DEFAULT_ENDED_RETENTION_MS
  const snapshotIntervalMs = deps.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS
  const snapshotActiveIntervalMs = Math.min(
    deps.snapshotActiveIntervalMs ?? DEFAULT_SNAPSHOT_ACTIVE_INTERVAL_MS,
    snapshotIntervalMs > 0 ? snapshotIntervalMs : Infinity,
  )
  const snapshotMaxFailures = deps.snapshotMaxFailures ?? DEFAULT_SNAPSHOT_MAX_FAILURES
  const onlineGraceMs = deps.onlineGraceMs ?? DEFAULT_ONLINE_GRACE_MS
  const probeBackoffMaxMs = deps.probeBackoffMaxMs ?? DEFAULT_PROBE_BACKOFF_MAX_MS
  const probeConcurrency = Math.max(1, deps.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY)
  const lastSeenPersistIntervalMs = deps.lastSeenPersistIntervalMs ?? DEFAULT_LAST_SEEN_PERSIST_MS
  const selfName = defaultSelfName()

  /** fingerprint → record. Source of truth in memory; disk is the mirror. */
  const hosts = new Map<string, HostRecord>()
  /** fingerprint → count of `forwardHttp` calls currently in flight. */
  const onlineCounts = new Map<string, number>()
  /** fingerprint → path (e.g. "/sessions", "/sessions/abc/output?lastN=80")
   *  → last successful GET response for that exact path. In-memory only,
   *  capped per host — see {@link cacheSessionsResponse}. */
  const sessionsCache = new Map<string, Map<string, CachedForwardHttpResponse>>()
  /** fingerprint → ms of the last successful dial (`add`, `forwardHttp`, poll). */
  const lastReachedAt = new Map<string, number>()
  /** fingerprint → ms of the last disk write of a `lastSeen` bump. */
  const lastSeenPersistedAt = new Map<string, number>()
  /** fingerprint → proactive capture (see module doc). In-memory only. */
  const snapshots = new Map<string, HostSnapshot>()
  /** fingerprint → running background poll. */
  const pollers = new Map<string, { timer: ReturnType<typeof setTimeout> | undefined; failures: number }>()
  /** fingerprint → capture currently running, so concurrent callers share it. */
  const snapshotsInFlight = new Map<string, Promise<boolean>>()

  let probesRunning = 0
  const probeWaiters: Array<() => void> = []
  async function withProbeSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (probesRunning >= probeConcurrency) await new Promise<void>(resolve => probeWaiters.push(resolve))
    probesRunning++
    try {
      return await fn()
    } finally {
      probesRunning--
      probeWaiters.shift()?.()
    }
  }

  /** A lifecycle change made outside `sweep()` (at load) still owes a disk write. */
  let lifecycleDirty = false
  let loaded = false
  async function ensureLoaded(): Promise<void> {
    if (loaded) return
    loaded = true
    try {
      const raw = await readFile(hostsPath, "utf8")
      const parsed: unknown = JSON.parse(raw)
      if (isHostsFile(parsed)) {
        for (const rec of parsed.hosts) {
          // Hosts a join token added before `addedVia` existed carry no
          // marker. Adopt the unmistakable shape (default fingerprint name,
          // no self-reported meta, never reached again since `add()`) as
          // "join" so the TTL sweep covers them; a manually added host that
          // was ever used has a moved `lastSeen` and stays "manual".
          if (isLegacyJoinedShape(rec)) rec.addedVia = "join"
          hosts.set(rec.fingerprint, rec)
        }
        if (applyLifecycle()) lifecycleDirty = true
        let i = 0
        for (const rec of hosts.values()) {
          if (rec.addedVia === "join" && !rec.ended) startSnapshotPoller(rec.fingerprint, snapshotActiveIntervalMs + i++ * RESUME_STAGGER_MS)
        }
      } else {
        log(`[hosts] ignoring ${hostsPath}: unrecognised format`)
      }
    } catch (err) {
      if (!isEnoent(err)) log(`[hosts] could not read ${hostsPath}: ${errMsg(err)}`)
    }
  }

  // Serialize persist() calls, same rationale as pairing-registry.ts: two
  // writes racing (an `add` and a `lastSeen` update from a concurrent
  // `forwardHttp`) must not land out of call order.
  let persistChain: Promise<void> = Promise.resolve()
  function persist(): Promise<void> {
    const run = persistChain.then(doPersist)
    persistChain = run.catch(() => {})
    return run
  }
  async function doPersist(): Promise<void> {
    const file: HostsFile = { v: HOSTS_VERSION, hosts: Array.from(hosts.values()) }
    const dir = dirname(hostsPath)
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.${basename(hostsPath)}.tmp-${process.pid}`)
    await writeFile(tmp, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, hostsPath)
  }

  function findHost(idOrName: string): HostRecord | undefined {
    const byFp = hosts.get(idOrName)
    if (byFp) return byFp
    for (const rec of hosts.values()) if (rec.name === idOrName) return rec
    return undefined
  }

  async function dialWithTimeout(wsUrl: string): Promise<FrameSink> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error(`dial timed out after ${dialTimeoutMs}ms`)), dialTimeoutMs)
    if (typeof timer.unref === "function") timer.unref()
    try {
      return await deps.dial(wsUrl, ac.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  async function add(
    offerUrl: string,
    name?: string,
    meta?: HostJoinMeta,
  ): Promise<{ fingerprint: string; name: string; rendezvousUrl: string }> {
    await ensureLoaded()
    const offer = await parseOfferUrl(offerUrl, { now: now() })
    if (offer.scope !== "host") {
      throw new Error(
        "this offer is not host-scoped — it only grants remote-control access, not host " +
          "registration; ask the other machine to run `agentproto pair offer --host` and use " +
          "that offer instead",
      )
    }

    const { route, auth } = await deriveOfferTokens(offer.secret)
    const raw = await dialWithTimeout(rvUrl(offer.rendezvousUrl, route))

    const started = await startClientHandshake({
      daemonX25519Pub: offer.daemonX25519Pub,
      daemonEd25519Pub: offer.daemonEd25519Pub,
      authToken: auth,
      clientName: name ?? selfName,
    })
    let session: PairingSession | null = null
    const wrapped = await clientHandshakeOverSink(
      raw,
      encodePairingMessage(started.hello),
      async replyBytes => {
        session = await started.complete(decodePairingReply(replyBytes))
        return session
      },
      { timeoutMs: handshakeTimeoutMs },
    )
    if (!session) throw new Error("handshake did not derive a session")
    const derived: PairingSession = session

    // Defence in depth: the daemon we just authenticated (via `sig`) must be
    // the one the offer named. `parseOfferUrl` already checked
    // id == fingerprint(pk); this reconfirms against what the handshake
    // itself derived.
    if (derived.peerFingerprint !== offer.fingerprint) {
      wrapped.close("fingerprint mismatch")
      throw new Error(
        `host fingerprint ${derived.peerFingerprint} does not match the offer's ${offer.fingerprint}`,
      )
    }

    const pairRoot = await derivePairRoot(derived)
    const nowIso = new Date(now()).toISOString()
    const existing = hosts.get(offer.fingerprint)
    // Sticky "manual": a human's own `pair offer --host` + `devices add`
    // ceremony must never become prunable just because the SAME box later
    // (or concurrently) also dials in with a join token — once a fingerprint
    // has been manually added, it stays `addedVia: "manual"` regardless of
    // what any later `add()` call for it reports. The reverse (a join-added
    // host later manually re-added) is allowed to flip to "manual" — that's
    // an explicit human action taking ownership of it.
    const addedVia: HostRecord["addedVia"] =
      existing?.addedVia === "manual" ? "manual" : meta?.joined ? "join" : "manual"
    const record: HostRecord = {
      fingerprint: offer.fingerprint,
      name: name ?? offer.fingerprint,
      daemonX25519Pub: offer.daemonX25519Pub,
      daemonEd25519Pub: offer.daemonEd25519Pub,
      rendezvousUrl: offer.rendezvousUrl,
      pairRoot,
      createdAt: existing?.createdAt ?? nowIso,
      lastSeen: nowIso,
      ...(meta?.provider ? { provider: meta.provider } : {}),
      ...(meta?.sandboxId ? { sandboxId: meta.sandboxId } : {}),
      ...(meta?.labels ? { labels: meta.labels } : {}),
      addedVia,
    }
    hosts.set(record.fingerprint, record)
    lastReachedAt.set(record.fingerprint, now())
    lastSeenPersistedAt.set(record.fingerprint, now())
    await persist()
    log(`[hosts] added ${record.fingerprint} (${record.name})`)
    // First poll shortly after the join: the runner is only just starting its session.
    if (addedVia === "join") startSnapshotPoller(record.fingerprint, snapshotActiveIntervalMs)

    // The add ceremony is one-shot — close the channel; `forwardHttp` dials
    // fresh, on demand, every time.
    wrapped.close("add complete")
    return { fingerprint: record.fingerprint, name: record.name, rendezvousUrl: record.rendezvousUrl }
  }

  /** A dial to this host is running right now. */
  function inFlight(fingerprint: string): boolean {
    return (onlineCounts.get(fingerprint) ?? 0) > 0
  }

  function markEndedRecord(rec: HostRecord, reason: "goodbye" | "ttl", atMs: number): void {
    rec.ended = true
    rec.endedAt = new Date(atMs).toISOString()
    rec.endReason = reason
    lastReachedAt.delete(rec.fingerprint)
    stopSnapshotPoller(rec.fingerprint)
  }

  /**
   * One pass of the join-host lifecycle: unreachable past `endedTtlMs` ⇒ ended
   * (stamped at the moment the TTL lapsed, so a host unseen for weeks is also
   * past retention immediately); ended past `endedRetentionMs` ⇒ deleted. A
   * manually added host is never touched. Returns whether anything changed.
   */
  function applyLifecycle(): boolean {
    const t = now()
    let changed = false
    for (const rec of Array.from(hosts.values())) {
      if (rec.addedVia !== "join") continue
      if (!rec.ended && endedTtlMs > 0 && !inFlight(rec.fingerprint)) {
        const lastSeenMs = Date.parse(rec.lastSeen)
        if (t - lastSeenMs >= endedTtlMs) {
          markEndedRecord(rec, "ttl", Math.min(t, lastSeenMs + endedTtlMs))
          log(`[hosts] ${rec.fingerprint} (${rec.name}) ended: unreachable for over ${endedTtlMs}ms`)
          changed = true
        }
      }
      if (rec.ended && endedRetentionMs > 0 && t - Date.parse(rec.endedAt ?? "") >= endedRetentionMs) {
        forgetHost(rec.fingerprint)
        log(`[hosts] pruned ${rec.fingerprint} (${rec.name}): ended over ${endedRetentionMs}ms ago`)
        changed = true
      }
    }
    return changed
  }

  async function sweep(): Promise<void> {
    await ensureLoaded()
    const changed = applyLifecycle()
    if (!changed && !lifecycleDirty) return
    lifecycleDirty = false
    await persist().catch(err => log(`[hosts] sweep persist failed: ${errMsg(err)}`))
  }

  async function markEnded(idOrName: string, reason: "goodbye" | "ttl" = "goodbye"): Promise<boolean> {
    await ensureLoaded()
    const rec = findHost(idOrName)
    if (!rec || rec.addedVia !== "join") return false
    if (rec.ended) return true
    markEndedRecord(rec, reason, now())
    log(`[hosts] ${rec.fingerprint} (${rec.name}) ended: ${reason}`)
    await persist().catch(err => log(`[hosts] ended persist failed: ${errMsg(err)}`))
    return true
  }

  /** Drop a host and everything derived from it in memory. */
  function forgetHost(fingerprint: string): void {
    hosts.delete(fingerprint)
    sessionsCache.delete(fingerprint)
    snapshots.delete(fingerprint)
    lastReachedAt.delete(fingerprint)
    lastSeenPersistedAt.delete(fingerprint)
    stopSnapshotPoller(fingerprint)
  }

  async function list(): Promise<HostRecord[]> {
    await sweep()
    const t = now()
    return Array.from(hosts.values()).map(r => {
      const copy = { ...r }
      if (
        r.addedVia !== "join" &&
        endedTtlMs > 0 &&
        !inFlight(r.fingerprint) &&
        t - Date.parse(r.lastSeen) >= endedTtlMs
      ) {
        copy.stale = true
      }
      return copy
    })
  }

  async function renameHost(idOrName: string, newName: string): Promise<boolean> {
    const trimmed = newName.trim()
    if (!trimmed) throw new Error("host name must not be empty")
    await ensureLoaded()
    const target = findHost(idOrName)
    if (!target) return false
    target.name = trimmed
    await persist()
    log(`[hosts] renamed ${target.fingerprint} to "${trimmed}"`)
    return true
  }

  async function revoke(idOrName: string): Promise<boolean> {
    await ensureLoaded()
    const target = findHost(idOrName)
    if (!target) return false
    forgetHost(target.fingerprint)
    await persist()
    log(`[hosts] revoked ${target.fingerprint} (${target.name})`)
    return true
  }

  function isOnline(fingerprint: string): boolean {
    if ((onlineCounts.get(fingerprint) ?? 0) > 0) return true
    const reached = lastReachedAt.get(fingerprint)
    return reached !== undefined && now() - reached < onlineGraceMs
  }

  /** A dial to `record` just succeeded: it is online, and `lastSeen` moves.
   *  The in-memory value is always current; the disk write is throttled so a
   *  polled host doesn't rewrite `hosts.json` every few seconds. */
  async function markReached(record: HostRecord): Promise<void> {
    const t = now()
    lastReachedAt.set(record.fingerprint, t)
    // A success clears the failure streak that drives the re-pair hint.
    handshakeFailures.delete(record.fingerprint)
    record.lastSeen = new Date(t).toISOString()
    record.lastProbeAt = record.lastSeen
    const hadError = record.lastError !== undefined
    delete record.lastError
    const persistedAt = lastSeenPersistedAt.get(record.fingerprint)
    if (!hadError && persistedAt !== undefined && t - persistedAt < lastSeenPersistIntervalMs) return
    lastSeenPersistedAt.set(record.fingerprint, t)
    await persist().catch(err => log(`[hosts] lastSeen persist failed: ${errMsg(err)}`))
  }

  /** A dial to `record` failed on every attempt. `lastProbeAt`/`lastError`
   *  always update in memory; the disk write happens only when the error text
   *  changes, so a host that stays down doesn't rewrite `hosts.json` on every poll. */
  async function markUnreachable(record: HostRecord, message: string): Promise<void> {
    record.lastProbeAt = new Date(now()).toISOString()
    const error = message.slice(0, MAX_LAST_ERROR_CHARS)
    // Diag-only: count the consecutive-failure streak and, once it's long
    // enough that transient flakiness is ruled out, log the re-pair
    // remediation line — exactly once per streak so daemon.log doesn't
    // drown in it.
    const failures = (handshakeFailures.get(record.fingerprint) ?? 0) + 1
    handshakeFailures.set(record.fingerprint, failures)
    if (failures === HOST_HANDSHAKE_FAILURE_HINT_THRESHOLD) {
      log(
        `[hosts] ${record.fingerprint} (${record.name}): failed to dial/handshake ${failures} times in a row — ` +
          HOST_HANDSHAKE_REMEDIATION_HINT,
      )
    }
    if (record.lastError === error) return
    record.lastError = error
    await persist().catch(err => log(`[hosts] lastError persist failed: ${errMsg(err)}`))
  }

  /**
   * Shared dial/handshake/retry core for `forwardHttp` and
   * `forwardHttpStream` — everything up to (and including) a ready
   * `TunnelClient`, current-then-previous epoch, same hung-up-on-hello
   * tracking for the re-pair hint. Bumps `onlineCounts` on entry; the
   * caller is responsible for decrementing it (and closing the returned
   * client) once it's actually done with the connection — immediately
   * for a buffered call, on stream-drain for a streamed one.
   */
  async function connectToHost(record: HostRecord): Promise<TunnelClient> {
    const epoch = currentEpoch(now())
    const attempts = [epoch, epoch - 1]
    let lastErr: unknown
    let hungUpOnHello = 0
    for (const e of attempts) {
      const { route, auth } = await deriveEpochTokens(record.pairRoot, e)
      let raw: FrameSink
      try {
        raw = await dialWithTimeout(rvUrl(record.rendezvousUrl, route))
      } catch (err) {
        lastErr = err
        continue
      }
      try {
        const started = await startClientHandshake({
          daemonX25519Pub: record.daemonX25519Pub,
          daemonEd25519Pub: record.daemonEd25519Pub,
          authToken: auth,
          clientName: record.name,
        })
        const wrapped = await clientHandshakeOverSink(
          raw,
          encodePairingMessage(started.hello),
          replyBytes => started.complete(decodePairingReply(replyBytes)),
          { timeoutMs: handshakeTimeoutMs },
        )
        const client = createTunnelClient({ sink: wrapped })
        await client.ready()
        await markReached(record)
        return client
      } catch (err) {
        lastErr = err
        if (err instanceof Error && /transport closed during handshake/.test(err.message)) hungUpOnHello++
        try {
          raw.close("handshake failed")
        } catch {
          /* ignore */
        }
      }
    }

    // Every attempt reached a host that hung up on our hello: the likeliest
    // cause is a host still on pair/v1, which refuses a v2 hello without a
    // word (mirrors pair-transport.ts's openPairChannel).
    const hint =
      hungUpOnHello === attempts.length
        ? ` — the host hung up on the pair/v2 hello; if it runs an older agentproto ` +
          `(pair/v1), upgrade it and re-pair: run \`agentproto pair offer --host\` on the ` +
          `host, then \`agentproto devices add\` here. (${PAIRING_PROTOCOL_OUTDATED_MESSAGE})`
        : ""
    const failure = `could not reach host ${record.fingerprint} via ${record.rendezvousUrl}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }${hint}`
    await markUnreachable(record, errMsg(lastErr))
    throw new Error(failure)
  }

  function toTunnelReq(req: ForwardHttpRequest): TunnelHttpRequest {
    return {
      method: req.method,
      path: req.path,
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.body ? { body: Buffer.from(req.body) } : {}),
    }
  }

  /** Cache a successful (2xx) GET `/sessions*` response for
   *  `getSessionsSnapshot`'s offline fallback. No-op for any other path
   *  (exec, device-inference, …) — this cache exists only to make session
   *  HISTORY survive a host going offline, not to snapshot arbitrary
   *  forwarded traffic. Also a no-op for a non-2xx response: caching a
   *  transient 4xx/5xx as "last-known-good" would keep re-serving that
   *  error, unchanged, for the rest of the host's retention once it
   *  actually does go offline. */
  function cacheSessionsResponse(fingerprint: string, req: ForwardHttpRequest, res: ForwardHttpResponse): void {
    if (req.method !== "GET" || !isSessionsPath(req.path)) return
    if (res.status < 200 || res.status >= 300) return
    if (res.body.byteLength > MAX_CACHED_SESSION_BODY_BYTES) return
    let byPath = sessionsCache.get(fingerprint)
    if (!byPath) {
      byPath = new Map()
      sessionsCache.set(fingerprint, byPath)
    }
    byPath.delete(req.path) // re-insert at the end so eviction below is LRU-ish
    byPath.set(req.path, {
      status: res.status,
      headers: { ...res.headers },
      body: res.body,
      stale: true,
      capturedAt: new Date(now()).toISOString(),
    })
    while (byPath.size > MAX_CACHED_SESSION_PATHS_PER_HOST) {
      const oldest = byPath.keys().next().value
      if (oldest === undefined) break
      byPath.delete(oldest)
    }
  }

  function getSessionsSnapshot(idOrName: string, path: string): ForwardHttpResponse | undefined {
    const record = findHost(idOrName)
    if (!record) return undefined
    const exact = sessionsCache.get(record.fingerprint)?.get(path)
    const derived = deriveFromSnapshot(snapshots.get(record.fingerprint), path)
    // Whichever capture is newer wins — a poll may be more recent than the
    // last query someone happened to make, or the other way round.
    const entry = derived && (!exact || Date.parse(derived.capturedAt) > Date.parse(exact.capturedAt)) ? derived : exact
    if (!entry) return undefined
    return { ...entry, headers: { ...entry.headers }, body: entry.body }
  }

  // ── proactive snapshots ────────────────────────────────────────

  function stopSnapshotPoller(fingerprint: string): void {
    const poller = pollers.get(fingerprint)
    if (!poller) return
    if (poller.timer) clearTimeout(poller.timer)
    pollers.delete(fingerprint)
  }

  /** (Re)start the background poll for a host. A poll already running for it
   *  is left alone — only its failure count resets, since the host just
   *  proved reachable. */
  function startSnapshotPoller(fingerprint: string, delayMs: number): void {
    if (snapshotIntervalMs <= 0) return
    const existing = pollers.get(fingerprint)
    if (existing) {
      existing.failures = 0
      return
    }
    const poller: { timer: ReturnType<typeof setTimeout> | undefined; failures: number } = {
      timer: undefined,
      failures: 0,
    }
    pollers.set(fingerprint, poller)
    const schedule = (ms: number): void => {
      poller.timer = setTimeout(() => void tick(), ms)
      if (typeof poller.timer.unref === "function") poller.timer.unref()
    }
    const tick = async (): Promise<void> => {
      if (pollers.get(fingerprint) !== poller || !hosts.get(fingerprint) || hosts.get(fingerprint)?.ended) return
      const ok = await withProbeSlot(() => captureSnapshot(fingerprint)).catch(() => false)
      if (pollers.get(fingerprint) !== poller) return
      poller.failures = ok ? 0 : poller.failures + 1
      if (poller.failures === snapshotMaxFailures) {
        log(`[hosts] snapshot poll for ${fingerprint} backing off: unreachable ${poller.failures}x (last capture kept)`)
      }
      if (poller.failures >= snapshotMaxFailures) {
        const steps = poller.failures - snapshotMaxFailures + 1
        schedule(Math.min(snapshotIntervalMs * 2 ** Math.min(steps, 16), Math.max(probeBackoffMaxMs, snapshotIntervalMs)))
        return
      }
      schedule(snapshotHasRunningSession(snapshots.get(fingerprint)) ? snapshotActiveIntervalMs : snapshotIntervalMs)
    }
    schedule(delayMs)
  }

  function captureSnapshot(fingerprint: string): Promise<boolean> {
    const running = snapshotsInFlight.get(fingerprint)
    if (running) return running
    const run = doCaptureSnapshot(fingerprint).finally(() => snapshotsInFlight.delete(fingerprint))
    snapshotsInFlight.set(fingerprint, run)
    return run
  }

  async function doCaptureSnapshot(fingerprint: string): Promise<boolean> {
    const record = hosts.get(fingerprint)
    if (!record) return false
    onlineCounts.set(fingerprint, (onlineCounts.get(fingerprint) ?? 0) + 1)
    let client: TunnelClient | undefined
    try {
      client = await connectToHost(record)
      const get = async (path: string): Promise<ForwardHttpResponse> => {
        const res = await withTimeout(
          client!.forwardHttp(toTunnelReq({ method: "GET", path })),
          SNAPSHOT_REQUEST_TIMEOUT_MS,
          `snapshot ${path}`,
        )
        return { status: res.status, headers: { ...res.headers }, body: new Uint8Array(res.body) }
      }
      const list = await get("/sessions")
      if (list.status < 200 || list.status >= 300 || list.body.byteLength > MAX_CACHED_SESSION_BODY_BYTES) return true
      const capturedAt = new Date(now()).toISOString()
      const prior = snapshots.get(fingerprint)
      // Merge, not replace: sessions that were in the prior capture but are
      // absent from this one (e.g. the runner already tore its session down
      // by the last poll at teardown) stay in the stored list, marked
      // `status: "gone"`, with their prior output tails kept — a finished
      // host's history is exactly what these snapshots exist to preserve.
      // The merged list is capped like a fresh one: at most
      // `SNAPSHOT_MAX_SESSIONS` rows, newest activity first, and never
      // larger than `MAX_CACHED_SESSION_BODY_BYTES` (oldest rows dropped
      // first). An empty new list can therefore never overwrite a non-empty
      // prior snapshot.
      const rows = mergedSnapshotRows(list.body, prior?.listBody)
        .sort((a, b) => snapshotRowTs(b) - snapshotRowTs(a))
        .slice(0, SNAPSHOT_MAX_SESSIONS)
      let mergedBody = snapshotListBody(list.body, rows)
      while (mergedBody.byteLength > MAX_CACHED_SESSION_BODY_BYTES && rows.length > 0) {
        rows.pop()
        mergedBody = snapshotListBody(list.body, rows)
      }
      const rowIds = new Set(
        rows.flatMap(r => (typeof r["id"] === "string" ? [r["id"]] : [])),
      )
      const outputs = new Map<string, CapturedOutput>()
      for (let i = rows.length - 1; i >= 0; i--) {
        const id = rows[i]?.["id"]
        if (typeof id !== "string") continue
        const priorOut = prior?.outputs.get(id)
        if (priorOut) outputs.set(id, priorOut)
      }
      for (const id of pickSnapshotSessionIds(list.body)) {
        if (!rowIds.has(id)) continue
        try {
          const out = await get(`/sessions/${encodeURIComponent(id)}/output?lastN=${SNAPSHOT_OUTPUT_LINES}`)
          const parsed = out.status >= 200 && out.status < 300 ? parseOutputBody(out.body) : undefined
          if (parsed) outputs.set(id, { capturedAt: new Date(now()).toISOString(), body: parsed })
          else if (prior?.outputs.has(id)) outputs.set(id, prior.outputs.get(id)!)
        } catch (err) {
          // One session's tail failing (or the tunnel dropping mid-capture)
          // must not discard the rest — keep whatever we had for it.
          if (prior?.outputs.has(id)) outputs.set(id, prior.outputs.get(id)!)
          log(`[hosts] snapshot of ${fingerprint} session ${id} failed: ${errMsg(err)}`)
        }
      }
      snapshots.set(fingerprint, {
        capturedAt,
        listStatus: list.status,
        listHeaders: list.headers,
        listBody: mergedBody,
        outputs,
      })
      return true
    } finally {
      if (client) await client.close().catch(() => {})
      const remaining = (onlineCounts.get(fingerprint) ?? 1) - 1
      if (remaining > 0) onlineCounts.set(fingerprint, remaining)
      else onlineCounts.delete(fingerprint)
    }
  }

  async function snapshotNow(idOrName: string): Promise<boolean> {
    if (snapshotIntervalMs <= 0) return false
    await ensureLoaded()
    const record = findHost(idOrName)
    if (!record) return false
    try {
      return await captureSnapshot(record.fingerprint)
    } catch (err) {
      log(`[hosts] snapshot of ${record.fingerprint} failed: ${errMsg(err)}`)
      return false
    }
  }

  async function forwardHttp(idOrName: string, req: ForwardHttpRequest): Promise<ForwardHttpResponse> {
    await ensureLoaded()
    const record = findHost(idOrName)
    if (!record) throw hostLookupError(idOrName)

    onlineCounts.set(record.fingerprint, (onlineCounts.get(record.fingerprint) ?? 0) + 1)
    let client: TunnelClient | undefined
    try {
      client = await connectToHost(record)
      const res = await client.forwardHttp(toTunnelReq(req))
      const result: ForwardHttpResponse = { status: res.status, headers: { ...res.headers }, body: new Uint8Array(res.body) }
      cacheSessionsResponse(record.fingerprint, req, result)
      return result
    } finally {
      if (client) await client.close().catch(() => {})
      const remaining = (onlineCounts.get(record.fingerprint) ?? 1) - 1
      if (remaining > 0) onlineCounts.set(record.fingerprint, remaining)
      else onlineCounts.delete(record.fingerprint)
    }
  }

  async function forwardHttpStream(
    idOrName: string,
    req: ForwardHttpRequest,
  ): Promise<ForwardHttpStreamResponse> {
    await ensureLoaded()
    const record = findHost(idOrName)
    if (!record) throw hostLookupError(idOrName)

    onlineCounts.set(record.fingerprint, (onlineCounts.get(record.fingerprint) ?? 0) + 1)
    let decremented = false
    const decrement = (): void => {
      if (decremented) return
      decremented = true
      const remaining = (onlineCounts.get(record.fingerprint) ?? 1) - 1
      if (remaining > 0) onlineCounts.set(record.fingerprint, remaining)
      else onlineCounts.delete(record.fingerprint)
    }

    let client: TunnelClient
    try {
      client = await connectToHost(record)
    } catch (err) {
      decrement()
      throw err
    }
    let res: TunnelHttpStreamResponse
    try {
      res = await client.forwardHttpStream(toTunnelReq(req))
    } catch (err) {
      await client.close().catch(() => {})
      decrement()
      throw err
    }
    const cleanup = (): void => {
      void client.close().catch(() => {})
      decrement()
    }
    return { status: res.status, headers: { ...res.headers }, body: wrapStreamWithCleanup(res.body, cleanup) }
  }

  return {
    add,
    list,
    rename: renameHost,
    revoke,
    isOnline,
    forwardHttp,
    forwardHttpStream,
    getSessionsSnapshot,
    snapshotNow,
    markEnded,
    sweep,
    start: sweep,
  }
}

/**
 * Wrap a Web `ReadableStream` so `cleanup` runs exactly once, whichever way
 * the stream ends: fully drained, upstream error, or the consumer cancelling
 * early (e.g. the OpenAI client aborting a chat/completions stream). This is
 * what lets `forwardHttpStream` keep the tunnel client (and `isOnline`) alive
 * for the whole SSE lifetime instead of closing right after headers arrive.
 */
function wrapStreamWithCleanup(
  source: ReadableStream<Uint8Array>,
  cleanup: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let cleanedUp = false
  const runCleanup = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    cleanup()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          runCleanup()
          return
        }
        controller.enqueue(value)
      } catch (err) {
        controller.error(err)
        runCleanup()
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        runCleanup()
      }
    },
  })
}

// ── helpers ────────────────────────────────────────────────────

/** See `ensureLoaded`: the shape of a host a join token added before
 *  `HostRecord.addedVia` existed. */
function isLegacyJoinedShape(rec: HostRecord): boolean {
  return (
    rec.addedVia === undefined &&
    rec.name === rec.fingerprint &&
    rec.provider === undefined &&
    rec.sandboxId === undefined &&
    rec.labels === undefined &&
    rec.lastSeen === rec.createdAt
  )
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    if (typeof timer.unref === "function") timer.unref()
    p.then(
      v => {
        clearTimeout(timer)
        resolve(v)
      },
      e => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function parseJsonBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"))
  } catch {
    return undefined
  }
}

function snapshotSessionRows(body: Uint8Array): Array<Record<string, unknown>> {
  const parsed = parseJsonBody(body)
  const rows = parsed !== null && typeof parsed === "object" ? (parsed as { sessions?: unknown }).sessions : undefined
  return Array.isArray(rows)
    ? rows.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
    : []
}

/** Ids of the sessions worth capturing output for: most recently active first,
 *  capped at `SNAPSHOT_MAX_SESSIONS`. Rows from the NEW list only — a merged
 *  "gone" row is already carried forward from the prior snapshot. */
function pickSnapshotSessionIds(listBody: Uint8Array): string[] {
  const ts = snapshotRowTs
  return snapshotSessionRows(listBody)
    .filter(r => typeof r["id"] === "string")
    .sort((a, b) => ts(b) - ts(a))
    .slice(0, SNAPSHOT_MAX_SESSIONS)
    .map(r => r["id"] as string)
}

/** Registration timestamp of a session row (0 when it has none). Note that
 *  ended/exited rows sort fine — they usually carry `lastActivityAt` too, so
 *  a session that already exited by the last capture still gets its output
 *  tail picked up. */
function snapshotRowTs(r: Record<string, unknown>): number {
  const v = r["lastActivityAt"] ?? r["startedAt"]
  return typeof v === "string" ? Date.parse(v) || 0 : 0
}

/** Prior and new session rows merged by id: rows only in the NEW list are
 *  kept as-is; rows only in the PRIOR list are kept with `status: "gone"`
 *  (their other fields preserved — the last descriptor the host ever
 *  reported); rows in both take the new descriptor. */
function mergedSnapshotRows(newBody: Uint8Array, priorBody: Uint8Array | undefined): Array<Record<string, unknown>> {
  const prior = priorBody === undefined ? [] : snapshotSessionRows(priorBody)
  const fresh = snapshotSessionRows(newBody)
  const byId = new Map<string, Record<string, unknown>>()
  for (const r of prior) if (typeof r["id"] === "string") byId.set(r["id"], r)
  for (const r of fresh) if (typeof r["id"] === "string") byId.set(r["id"], r)
  const rows: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const r of fresh) {
    rows.push(r)
    if (typeof r["id"] === "string") seen.add(r["id"])
  }
  for (const [id, r] of byId) {
    if (seen.has(id)) continue
    rows.push({ ...r, id, status: "gone" })
  }
  return rows
}

/** Rebuild a `GET /sessions` response body from a new list wrapper plus the
 *  (merged) session rows. */
function snapshotListBody(newBody: Uint8Array, rows: Array<Record<string, unknown>>): Uint8Array {
  const parsed = parseJsonBody(newBody)
  const wrapper =
    parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { sessions: [], ok: true }
  return new TextEncoder().encode(JSON.stringify({ ...wrapper, sessions: rows }))
}

function snapshotHasRunningSession(snap: HostSnapshot | undefined): boolean {
  if (!snap) return false
  return snapshotSessionRows(snap.listBody).some(r => r["status"] === "running" || r["status"] === "starting")
}

function parseOutputBody(body: Uint8Array): CapturedOutput["body"] | undefined {
  const parsed = parseJsonBody(body)
  if (parsed === null || typeof parsed !== "object") return undefined
  const rec = parsed as Record<string, unknown>
  if (!Array.isArray(rec["lines"]) || !rec["lines"].every(l => typeof l === "string")) return undefined
  return rec as CapturedOutput["body"]
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*\u0007/g

/** Serve a `GET /sessions` or `GET /sessions/:id/output` request out of a
 *  proactive capture. Only the plain forms are derivable (`/sessions` with no
 *  query, output with `lastN`/`clean`); anything else (`?since=`, `?fields=`,
 *  …) is left to the exact-path cache. */
function deriveFromSnapshot(snap: HostSnapshot | undefined, path: string): CachedForwardHttpResponse | undefined {
  if (!snap) return undefined
  const q = path.indexOf("?")
  const pathname = q === -1 ? path : path.slice(0, q)
  const query = new URLSearchParams(q === -1 ? "" : path.slice(q + 1))
  if (pathname === "/sessions") {
    if ([...query.keys()].length > 0) return undefined
    return {
      status: snap.listStatus,
      headers: { ...snap.listHeaders },
      body: snap.listBody,
      stale: true,
      capturedAt: snap.capturedAt,
    }
  }
  const m = pathname.match(/^\/sessions\/([^/]+)\/output$/)
  if (!m) return undefined
  const captured = snap.outputs.get(decodeURIComponent(m[1] ?? ""))
  if (!captured) return undefined
  for (const k of query.keys()) if (k !== "lastN" && k !== "clean") return undefined
  const lastNRaw = Number(query.get("lastN") ?? "80")
  const limit = Number.isInteger(lastNRaw) && lastNRaw >= 1 ? Math.min(lastNRaw, 500) : 80
  const clean = ["1", "true"].includes(query.get("clean") ?? "")
  let lines = captured.body.lines.slice(-limit)
  if (clean) {
    lines = lines
      .map(l => l.replace(ANSI_RE, "").trimEnd())
      .filter(l => l.trim().length > 0)
  }
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify({ ...captured.body, lines })),
    stale: true,
    capturedAt: captured.capturedAt,
  }
}

function isHostsFile(v: unknown): v is HostsFile {
  if (typeof v !== "object" || v === null) return false
  const rec = v as Record<string, unknown>
  if (rec["v"] !== HOSTS_VERSION) return false
  if (!Array.isArray(rec["hosts"])) return false
  return rec["hosts"].every(isHostRecord)
}

/** Read-only snapshot of `hosts.json` (the read-only twin of
 *  `readPairingsSnapshot`): for callers that just want the persisted
 *  records — e.g. `agentproto doctor`'s devices check flagging a host
 *  channel that persistently fails its handshake (BOOTSTRAP P3 item 4).
 *  No dial, no rendezvous, no `loadIdentity` deps. Never throws — a
 *  missing or malformed file yields `[]`. */
export async function readHostsSnapshot(path?: string): Promise<HostRecord[]> {
  try {
    const raw = await readFile(path ?? defaultHostsPath(), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (!isHostsFile(parsed)) return []
    return parsed.hosts.map(rec => ({ ...rec }))
  } catch {
    return []
  }
}

function isHostRecord(v: unknown): v is HostRecord {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r["fingerprint"] === "string" &&
    typeof r["name"] === "string" &&
    typeof r["daemonX25519Pub"] === "string" &&
    typeof r["daemonEd25519Pub"] === "string" &&
    typeof r["rendezvousUrl"] === "string" &&
    typeof r["pairRoot"] === "string" &&
    typeof r["createdAt"] === "string" &&
    typeof r["lastSeen"] === "string"
  )
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  )
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The one "no host matched" lookup failure, with the pairing-direction hint
 * that made `pair offer --host` (recap E9) take three attempts live: devices
 * resolve role:host only, and an offer accepted on the WRONG side inverts
 * the roles. The message prefix stays grep-compatible ("no host matched").
 */
export function hostLookupError(idOrName: string): Error {
  return new Error(
    `no host matched "${idOrName}" — devices resolve role:host only: ` +
      `if you accepted an offer on the other machine, the roles may be ` +
      `inverted; see \`agentproto pair --help\``,
  )
}
