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
 * `isOnline(fingerprint)` mirrors `PairingRegistry.isOnline`: it's true only
 * while a `forwardHttp()` call for that fingerprint is in flight (a
 * reference count, incremented on dial and decremented in a `finally`).
 * There is no live probe backing `list()` — that would make `devices list`
 * slow/flaky over N hosts — so `list()`'s `online` is only ever true
 * immediately after (or during) an actual `forwardHttp`/`devices status`
 * call, never a background heartbeat. That's enough to make `devices list`
 * show the right thing right after `devices status`/`exec`, which is what
 * matters for this PR; a standing/autoconnect host connection with a real
 * liveness signal is PR-D's to build.
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
  /** ISO-8601 of the most recent successful `forwardHttp`. */
  lastSeen: string
  /** Set on a host added under the retired pair/v1 protocol. Present for
   *  parity with `PairingRecord`/`ClientPairing`; pair/v1 offers are refused
   *  by `parseOfferUrl` before `add()` ever sees them, so this is currently
   *  unreachable — kept so a future downgrade path has somewhere to flag it. */
  legacy?: true
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
  add(offerUrl: string, name?: string): Promise<{ fingerprint: string; name: string; rendezvousUrl: string }>
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
}

function defaultHostsPath(): string {
  return join(homedir(), ".agentproto", "hosts.json")
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
  const selfName = defaultSelfName()

  /** fingerprint → record. Source of truth in memory; disk is the mirror. */
  const hosts = new Map<string, HostRecord>()
  /** fingerprint → count of `forwardHttp` calls currently in flight. */
  const onlineCounts = new Map<string, number>()

  let loaded = false
  async function ensureLoaded(): Promise<void> {
    if (loaded) return
    loaded = true
    try {
      const raw = await readFile(hostsPath, "utf8")
      const parsed: unknown = JSON.parse(raw)
      if (isHostsFile(parsed)) {
        for (const rec of parsed.hosts) hosts.set(rec.fingerprint, rec)
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
    const record: HostRecord = {
      fingerprint: offer.fingerprint,
      name: name ?? offer.fingerprint,
      daemonX25519Pub: offer.daemonX25519Pub,
      daemonEd25519Pub: offer.daemonEd25519Pub,
      rendezvousUrl: offer.rendezvousUrl,
      pairRoot,
      createdAt: hosts.get(offer.fingerprint)?.createdAt ?? nowIso,
      lastSeen: nowIso,
    }
    hosts.set(record.fingerprint, record)
    await persist()
    log(`[hosts] added ${record.fingerprint} (${record.name})`)

    // The add ceremony is one-shot — close the channel; `forwardHttp` dials
    // fresh, on demand, every time.
    wrapped.close("add complete")
    return { fingerprint: record.fingerprint, name: record.name, rendezvousUrl: record.rendezvousUrl }
  }

  async function list(): Promise<HostRecord[]> {
    await ensureLoaded()
    return Array.from(hosts.values()).map(r => ({ ...r }))
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
    hosts.delete(target.fingerprint)
    await persist()
    log(`[hosts] revoked ${target.fingerprint} (${target.name})`)
    return true
  }

  function isOnline(fingerprint: string): boolean {
    return (onlineCounts.get(fingerprint) ?? 0) > 0
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
        record.lastSeen = new Date(now()).toISOString()
        await persist().catch(err => log(`[hosts] lastSeen persist failed: ${errMsg(err)}`))
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
    throw new Error(
      `could not reach host ${record.fingerprint} via ${record.rendezvousUrl}: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }${hint}`,
    )
  }

  function toTunnelReq(req: ForwardHttpRequest): TunnelHttpRequest {
    return {
      method: req.method,
      path: req.path,
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.body ? { body: Buffer.from(req.body) } : {}),
    }
  }

  async function forwardHttp(idOrName: string, req: ForwardHttpRequest): Promise<ForwardHttpResponse> {
    await ensureLoaded()
    const record = findHost(idOrName)
    if (!record) throw new Error(`no host matched "${idOrName}"`)

    onlineCounts.set(record.fingerprint, (onlineCounts.get(record.fingerprint) ?? 0) + 1)
    let client: TunnelClient | undefined
    try {
      client = await connectToHost(record)
      const res = await client.forwardHttp(toTunnelReq(req))
      return { status: res.status, headers: { ...res.headers }, body: new Uint8Array(res.body) }
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
    if (!record) throw new Error(`no host matched "${idOrName}"`)

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

  return { add, list, rename: renameHost, revoke, isOnline, forwardHttp, forwardHttpStream }
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

function isHostsFile(v: unknown): v is HostsFile {
  if (typeof v !== "object" || v === null) return false
  const rec = v as Record<string, unknown>
  if (rec["v"] !== HOSTS_VERSION) return false
  if (!Array.isArray(rec["hosts"])) return false
  return rec["hosts"].every(isHostRecord)
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
