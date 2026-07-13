/**
 * Daemon-side pairing registry (design: DESIGN §3/§4, PLAN deliverable 2).
 *
 * Owns everything the daemon needs to be *paired with* over an untrusted
 * rendezvous:
 *
 *   - **Offer store** — in-memory, single-use, expiry-checked one-time tokens
 *     minted by `pair offer`. A daemon restart voids outstanding offers
 *     (acceptable + documented). The P1 `verifyOfferToken` predicate plugs in
 *     here and SPENDS the token on the first successful handshake.
 *   - **Pairings store** — `~/.agentproto/pairings.json` (0600, atomic write),
 *     one record per paired client: `{clientPub, name, fingerprint, createdAt,
 *     lastSeen, pairRoot, rendezvousUrl}`. `pairRoot` is the long-term shared
 *     secret (`derivePairRoot`) from which reconnect routing tokens derive.
 *   - **Rendezvous connections** — for a fresh offer, and for every persisted
 *     pairing on boot (autoconnect), the daemon dials the rendezvous *outbound*
 *     (`side=daemon&t=<token>`), runs `daemonHandshakeOverSink` with the P1
 *     crypto, and — on success — serves the spliced, E2E-wrapped channel exactly
 *     like `serve --connect` serves a tunnel host. The serving path itself is
 *     injected (`serve`) so this module stays free of pty/adapter concerns and
 *     the CLI can reuse its `createTunnelServer` config verbatim.
 *   - **Reconnect epochs** — a persisted pairing's standing connection uses the
 *     pairing-derived routing token `t' = HKDF(pairRoot, "rv-route"‖epoch)`,
 *     rotated per UTC day. The daemon parks on BOTH the current and previous
 *     epoch tokens so a client whose clock straddles midnight still finds it;
 *     reconnect-with-backoff keeps the standing connection alive.
 *   - **Revocation** — removing a pairing drops its rendezvous connections and
 *     stops the daemon parking on its tokens, so it can no longer be reached.
 *
 * ## Reconnect authentication (why no stable client key)
 *
 * P1's handshake carries only a client *ephemeral* key (regenerated per
 * handshake) — there is no persistent client identity key, and the PLAN forbids
 * changing the handshake. So a reconnect authenticates the client by
 * **possession of the epoch routing token**, which derives from `pairRoot` — a
 * secret only the paired client and daemon share (it fell out of the original
 * ECDH). The daemon dials a pairing's epoch token, and on that connection the
 * `verifyOfferToken` predicate accepts a hello whose offer-token field equals
 * that same epoch token (constant-time). Token possession ⇒ paired party. The
 * stored `fingerprint` (of the first handshake's ephemeral key) is a stable
 * display/revocation handle, not an authentication input.
 */

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, basename } from "node:path"
import {
  daemonHandshakeOverSink,
  type FrameSink,
  type E2eFrameSink,
} from "@agentproto/acp/tunnel"
import {
  decodePairingHello,
  encodePairingMessage,
  respondToHandshake,
  derivePairRoot,
  deriveEpochRoutingToken,
  currentEpoch,
  encodeOfferUrl,
  PairingError,
} from "@agentproto/secrets/pairing"
import {
  identityFingerprint,
  type DaemonIdentity,
} from "@agentproto/secrets/identity"

export const PAIRINGS_VERSION = 1 as const

/** One persisted pairing. Written verbatim to `pairings.json`. */
export interface PairingRecord {
  /** The client ephemeral public key from the FIRST handshake (a snapshot —
   *  reconnects use fresh ephemerals; this is not an auth input). */
  clientPub: string
  /** Human-facing label the client chose on `pair accept`. */
  name: string
  /** `identityFingerprint(clientPub)` from the first handshake — the stable
   *  display + revocation handle. */
  fingerprint: string
  /** ISO-8601 first-pair timestamp. */
  createdAt: string
  /** ISO-8601 of the most recent successful (re)connect. */
  lastSeen: string
  /** Long-term shared secret (base64), from which epoch routing tokens derive. */
  pairRoot: string
  /** Rendezvous endpoint to reconnect through. */
  rendezvousUrl: string
}

interface PairingsFile {
  v: typeof PAIRINGS_VERSION
  pairings: PairingRecord[]
}

/** Mode of a served channel — first-contact offer vs. an established reconnect. */
export type PairingChannelMode = "offer" | "reconnect"

/** Context handed to the injected `serve` when a channel comes up. */
export interface PairingChannelContext {
  mode: PairingChannelMode
  /** Stable pairing fingerprint (present for reconnect; for an offer it's the
   *  freshly-derived one). */
  fingerprint: string
  /** Client label. */
  name: string
}

/** Handle to a live served channel — the registry closes it on teardown. */
export interface PairingChannelHandle {
  close(): Promise<void>
}

export interface CreatedOffer {
  /** The one-time offer token (base64url). */
  token: string
  /** Offer expiry, unix seconds. */
  exp: number
  /** The full `agentproto://pair?…` offer URL. */
  url: string
  /** The daemon's identity fingerprint (shown to the human at accept time). */
  fingerprint: string
  /** The rendezvous the offer routes through. */
  rendezvousUrl: string
}

export interface CreateOfferInput {
  /** Time-to-live in ms. Default 10 minutes. */
  ttlMs?: number
  /** Rendezvous URL override; falls back to the configured default. */
  rendezvousUrl?: string
}

export interface PairingRegistryDeps {
  /** Lazily load (create on first use) the daemon identity. Kept lazy so a
   *  daemon that never pairs never writes an identity file. */
  loadIdentity: () => Promise<DaemonIdentity>
  /** Path to `pairings.json`. Defaults to `~/.agentproto/pairings.json`. */
  pairingsPath?: string
  /** Default rendezvous URL (from `config.pairing.rendezvous`). */
  defaultRendezvousUrl?: string
  /** Dial a rendezvous WS and adapt it to a FrameSink. Injected by the CLI
   *  (uses `ws` + `wrapWebSocket`). Rejects if the dial fails. The `signal`
   *  aborts on registry shutdown. */
  dial: (wsUrl: string, signal: AbortSignal) => Promise<FrameSink>
  /** Serve the E2E-wrapped channel (the CLI builds `createTunnelServer` over
   *  it with the same config `serve --connect` uses). */
  serve: (sink: E2eFrameSink, ctx: PairingChannelContext) => PairingChannelHandle
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number
  /** Diagnostic log sink. */
  log?: (line: string) => void
  /** Reconnect backoff floor / ceiling (ms). Defaults 1s / 30s. */
  reconnectMinMs?: number
  reconnectMaxMs?: number
  /** How long a parked daemon socket waits for a client hello before recycling
   *  the connection. Kept just under the broker's park timeout. Default 110s. */
  handshakeTimeoutMs?: number
}

export interface PairingRegistry {
  /** Mint a one-time offer + start dialing the rendezvous for it. */
  createOffer(input?: CreateOfferInput): Promise<CreatedOffer>
  /** All persisted pairings (copies). Loads `pairings.json` on first call. */
  list(): Promise<PairingRecord[]>
  /** Drop a pairing by fingerprint or name; stops its rendezvous connections.
   *  Returns false when nothing matched. */
  revoke(idOrName: string): Promise<boolean>
  /** Start standing reconnect connections for every persisted pairing. Call
   *  after the gateway is up (so the injected `serve` can reach it). */
  startAutoconnect(): Promise<void>
  /** Tear down every offer + reconnect connection and served channel. */
  shutdown(): Promise<void>
}

const DEFAULT_TTL_MS = 10 * 60_000
const DEFAULT_RECONNECT_MIN_MS = 1_000
const DEFAULT_RECONNECT_MAX_MS = 30_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 110_000

function defaultPairingsPath(): string {
  return join(homedir(), ".agentproto", "pairings.json")
}

function b64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Constant-time string compare (HMAC-blind so length never leaks). Mirrors the
 *  rendezvous/relay `timing-safe` pattern; inlined so runtime gains no dep. */
function constantTimeEqual(a: string, b: string): boolean {
  const key = randomBytes(32)
  const da = createHmac("sha256", key).update(a, "utf8").digest()
  const db = createHmac("sha256", key).update(b, "utf8").digest()
  return timingSafeEqual(da, db)
}

interface OfferEntry {
  token: string
  exp: number // unix seconds
  spent: boolean
  rendezvousUrl: string
}

/** One managed rendezvous connection loop (offer or a single epoch). */
interface ConnectionLoop {
  abort: AbortController
  /** Resolves when the loop has fully stopped. */
  done: Promise<void>
}

export function createPairingRegistry(deps: PairingRegistryDeps): PairingRegistry {
  const pairingsPath = deps.pairingsPath ?? defaultPairingsPath()
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const reconnectMinMs = deps.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS
  const reconnectMaxMs = deps.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS
  const handshakeTimeoutMs = deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS

  /** fingerprint → record. Source of truth in memory; disk is the mirror. */
  const pairings = new Map<string, PairingRecord>()
  /** token → offer. */
  const offers = new Map<string, OfferEntry>()
  /** Loops keyed for lifecycle: `offer:<token>` and `pair:<fp>:<slot>`. */
  const loops = new Map<string, ConnectionLoop>()
  /** Live served channels, so shutdown/revoke can close them. */
  const channels = new Set<PairingChannelHandle>()

  let shuttingDown = false

  // Pairings are loaded lazily (ensureLoaded) on the first list/offer/autoconnect
  // so construction stays synchronous and touches no disk.
  let loaded = false
  async function ensureLoaded(): Promise<void> {
    if (loaded) return
    loaded = true
    try {
      const raw = await readFile(pairingsPath, "utf8")
      const parsed: unknown = JSON.parse(raw)
      if (isPairingsFile(parsed)) {
        for (const rec of parsed.pairings) pairings.set(rec.fingerprint, rec)
      }
    } catch (err) {
      if (!isEnoent(err)) {
        log(`[pairing] could not read ${pairingsPath}: ${errMsg(err)}`)
      }
    }
  }

  async function persist(): Promise<void> {
    const file: PairingsFile = {
      v: PAIRINGS_VERSION,
      pairings: Array.from(pairings.values()),
    }
    const dir = dirname(pairingsPath)
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.${basename(pairingsPath)}.tmp-${process.pid}`)
    await writeFile(tmp, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, pairingsPath)
  }

  // ── connection loop ────────────────────────────────────────────

  interface LoopSpec {
    key: string
    rendezvousUrl: string
    /** Token to dial this iteration (recomputed for epoch loops). */
    token: () => string
    /** Verify the presented offer-token against the expected token for this
     *  connection. `expected` is what `token()` returned this iteration. */
    verify: (presented: string, expected: string) => boolean
    /** Whether to stop after the first successful serve (offers) vs. loop
     *  forever re-parking (reconnect). */
    singleUse: boolean
    /** Should the loop keep running? (e.g. offer not yet expired/spent, or the
     *  pairing still exists). Checked at the top of each iteration. */
    shouldContinue: () => boolean
    /** Build the serve context + persist side-effects on a successful pair. */
    onPaired: (
      session: import("@agentproto/secrets/pairing").PairingSession,
      hello: import("@agentproto/secrets/pairing").PairingHello,
    ) => Promise<PairingChannelContext>
  }

  function startLoop(spec: LoopSpec): void {
    if (loops.has(spec.key)) return
    const abort = new AbortController()
    const done = runLoop(spec, abort.signal).catch(err => {
      log(`[pairing] loop ${spec.key} ended: ${errMsg(err)}`)
    })
    loops.set(spec.key, { abort, done })
  }

  async function stopLoop(key: string): Promise<void> {
    const loop = loops.get(key)
    if (!loop) return
    loops.delete(key)
    loop.abort.abort()
    await loop.done.catch(() => {})
  }

  async function runLoop(spec: LoopSpec, signal: AbortSignal): Promise<void> {
    let backoff = reconnectMinMs
    while (!signal.aborted && spec.shouldContinue()) {
      const expected = spec.token()
      let sink: FrameSink
      try {
        sink = await deps.dial(dialUrl(spec.rendezvousUrl, expected), signal)
      } catch (err) {
        if (signal.aborted) break
        log(`[pairing] dial ${spec.key} failed: ${errMsg(err)}`)
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, reconnectMaxMs)
        continue
      }

      // Make the in-flight handshake abortable: closing the sink on shutdown
      // makes `daemonHandshakeOverSink` reject promptly (transport closed),
      // instead of blocking on its own timeout for up to handshakeTimeoutMs.
      const onAbort = (): void => {
        try {
          sink.close("registry shutdown")
        } catch {
          /* already closing */
        }
      }
      signal.addEventListener("abort", onAbort, { once: true })

      try {
        let capturedSession: import("@agentproto/secrets/pairing").PairingSession | null = null
        let capturedHello: import("@agentproto/secrets/pairing").PairingHello | null = null
        let wrapped: E2eFrameSink
        try {
          const identity = await deps.loadIdentity()
          wrapped = await daemonHandshakeOverSink(
            sink,
            helloBytes => {
              const hello = decodePairingHello(helloBytes)
              const result = respondToHandshake(hello, {
                identity,
                verifyOfferToken: presented => spec.verify(presented, expected),
              })
              capturedSession = result.session
              capturedHello = hello
              return { reply: encodePairingMessage(result.reply), keys: result.session }
            },
            { timeoutMs: handshakeTimeoutMs },
          )
        } catch (err) {
          if (signal.aborted) break
          // A park timeout, a rejected offer, or a tampered hello. Fail closed
          // and re-dial after a short backoff (park timeouts are common + benign).
          void err
          await sleep(backoff, signal)
          backoff = Math.min(backoff * 2, reconnectMaxMs)
          continue
        }

        backoff = reconnectMinMs // success resets

        if (!capturedSession || !capturedHello) {
          wrapped.close("internal: missing session")
          continue
        }

        let ctx: PairingChannelContext
        try {
          ctx = await spec.onPaired(capturedSession, capturedHello)
        } catch (err) {
          log(`[pairing] persist for ${spec.key} failed: ${errMsg(err)}`)
          wrapped.close("persist failed")
          continue
        }

        const handle = deps.serve(wrapped, ctx)
        channels.add(handle)
        log(`[pairing] channel up (${ctx.mode}) for ${ctx.fingerprint} via ${spec.key}`)

        await waitClosed(wrapped, signal)
        channels.delete(handle)
        await handle.close().catch(() => {})
        log(`[pairing] channel closed (${ctx.mode}) for ${ctx.fingerprint}`)

        if (spec.singleUse) break
      } finally {
        signal.removeEventListener("abort", onAbort)
      }
    }
  }

  // ── offer handling ─────────────────────────────────────────────

  async function createOffer(input: CreateOfferInput = {}): Promise<CreatedOffer> {
    await ensureLoaded()
    const rendezvousUrl = input.rendezvousUrl ?? deps.defaultRendezvousUrl
    if (!rendezvousUrl) {
      throw new PairingError(
        "malformed_offer",
        "no rendezvous configured — pass --rendezvous or set pairing.rendezvous in config.json",
      )
    }
    const identity = await deps.loadIdentity()
    const token = b64url(randomBytes(16))
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
    const exp = Math.floor((now() + ttlMs) / 1000)
    offers.set(token, { token, exp, spent: false, rendezvousUrl })

    const fingerprint = identityFingerprint(identity.x25519.pub)
    const url = encodeOfferUrl({
      v: 1,
      rendezvousUrl,
      fingerprint,
      daemonX25519Pub: identity.x25519.pub,
      daemonEd25519Pub: identity.ed25519.pub,
      token,
      exp,
    })

    startOfferLoop(token, rendezvousUrl)
    log(`[pairing] offer minted (exp ${new Date(exp * 1000).toISOString()}) via ${rendezvousUrl}`)
    return { token, exp, url, fingerprint, rendezvousUrl }
  }

  function offerValid(token: string): boolean {
    const entry = offers.get(token)
    return !!entry && !entry.spent && entry.exp * 1000 > now()
  }

  function startOfferLoop(token: string, rendezvousUrl: string): void {
    startLoop({
      key: `offer:${token}`,
      rendezvousUrl,
      token: () => token,
      shouldContinue: () => offerValid(token),
      singleUse: true,
      verify: (presented, expected) => {
        const entry = offers.get(expected)
        if (!entry || entry.spent || entry.exp * 1000 <= now()) return false
        if (!constantTimeEqual(presented, expected)) return false
        entry.spent = true // SPEND — single use
        return true
      },
      onPaired: async (session, hello) => {
        const pairRoot = derivePairRoot(session)
        const fingerprint = session.peerFingerprint
        const nowIso = new Date(now()).toISOString()
        const record: PairingRecord = {
          clientPub: hello.ePub,
          name: session.clientName ?? fingerprint,
          fingerprint,
          createdAt: pairings.get(fingerprint)?.createdAt ?? nowIso,
          lastSeen: nowIso,
          pairRoot,
          rendezvousUrl,
        }
        pairings.set(fingerprint, record)
        await persist()
        // Start standing reconnect connections so the client can come back.
        startReconnectLoops(record)
        return { mode: "offer", fingerprint, name: record.name }
      },
    })
  }

  // ── reconnect handling ─────────────────────────────────────────

  function startReconnectLoops(record: PairingRecord): void {
    // Two standing connections — current + previous epoch — so a client whose
    // clock sits on either side of the UTC-day boundary can still splice.
    for (const slot of ["cur", "prev"] as const) {
      const epochOf = () => (slot === "cur" ? currentEpoch(now()) : currentEpoch(now()) - 1)
      startLoop({
        key: `pair:${record.fingerprint}:${slot}`,
        rendezvousUrl: record.rendezvousUrl,
        token: () => deriveEpochRoutingToken(record.pairRoot, epochOf()),
        shouldContinue: () => pairings.has(record.fingerprint),
        singleUse: false,
        verify: (presented, expected) => constantTimeEqual(presented, expected),
        onPaired: async (session, _hello) => {
          const existing = pairings.get(record.fingerprint)
          if (existing) {
            existing.lastSeen = new Date(now()).toISOString()
            await persist().catch(err => log(`[pairing] lastSeen persist failed: ${errMsg(err)}`))
          }
          // Silence unused-session lint while keeping the signature uniform.
          void session
          return {
            mode: "reconnect",
            fingerprint: record.fingerprint,
            name: existing?.name ?? record.name,
          }
        },
      })
    }
  }

  async function startAutoconnect(): Promise<void> {
    await ensureLoaded()
    for (const record of pairings.values()) {
      startReconnectLoops(record)
    }
    if (pairings.size > 0) {
      log(`[pairing] autoconnect: standing connections for ${pairings.size} pairing(s)`)
    }
  }

  // ── revocation ─────────────────────────────────────────────────

  async function revoke(idOrName: string): Promise<boolean> {
    await ensureLoaded()
    let target: PairingRecord | undefined = pairings.get(idOrName)
    if (!target) {
      for (const rec of pairings.values()) {
        if (rec.name === idOrName) {
          target = rec
          break
        }
      }
    }
    if (!target) return false
    pairings.delete(target.fingerprint)
    await persist()
    // Stop parking on this pairing's tokens so it can no longer be reached.
    await stopLoop(`pair:${target.fingerprint}:cur`)
    await stopLoop(`pair:${target.fingerprint}:prev`)
    log(`[pairing] revoked ${target.fingerprint} (${target.name})`)
    return true
  }

  async function list(): Promise<PairingRecord[]> {
    await ensureLoaded()
    return Array.from(pairings.values()).map(r => ({ ...r }))
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    for (const key of Array.from(loops.keys())) {
      await stopLoop(key)
    }
    for (const handle of Array.from(channels)) {
      await handle.close().catch(() => {})
    }
    channels.clear()
  }

  return { createOffer, list, revoke, startAutoconnect, shutdown }
}

// ── helpers ────────────────────────────────────────────────────

function dialUrl(rendezvousUrl: string, token: string): string {
  const sep = rendezvousUrl.includes("?") ? "&" : "?"
  return `${rendezvousUrl}${sep}side=daemon&t=${encodeURIComponent(token)}`
}

function waitClosed(sink: E2eFrameSink, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (!sink.isOpen) {
      resolve()
      return
    }
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    sink.onClose(() => finish())
    signal.addEventListener("abort", () => {
      sink.close("registry shutdown")
      finish()
    })
  })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === "function") timer.unref()
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function isPairingsFile(v: unknown): v is PairingsFile {
  if (typeof v !== "object" || v === null) return false
  const rec = v as Record<string, unknown>
  if (rec["v"] !== PAIRINGS_VERSION) return false
  if (!Array.isArray(rec["pairings"])) return false
  return rec["pairings"].every(isPairingRecord)
}

function isPairingRecord(v: unknown): v is PairingRecord {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r["clientPub"] === "string" &&
    typeof r["name"] === "string" &&
    typeof r["fingerprint"] === "string" &&
    typeof r["createdAt"] === "string" &&
    typeof r["lastSeen"] === "string" &&
    typeof r["pairRoot"] === "string" &&
    typeof r["rendezvousUrl"] === "string"
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
