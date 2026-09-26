/**
 * Daemon-side pairing registry (design: DESIGN §3/§4, PLAN deliverable 2).
 *
 * Owns everything the daemon needs to be *paired with* over an untrusted
 * rendezvous:
 *
 *   - **Offer store** — in-memory, single-use, expiry-checked one-time offer
 *     secrets minted by `pair offer`. A daemon restart voids outstanding offers
 *     (acceptable + documented). The daemon parks on the offer's ROUTE token and
 *     the handshake's `verifyAuthToken` predicate checks the sealed AUTH token,
 *     SPENDING the offer on the first successful handshake (a wrong token spends
 *     nothing).
 *   - **Pairings store** — `~/.agentproto/pairings.json` (0600, atomic write),
 *     one record per paired client: `{clientPub, name, fingerprint, createdAt,
 *     lastSeen, pairRoot, rendezvousUrl}`. `pairRoot` is the long-term shared
 *     secret (`derivePairRoot`) from which reconnect routing tokens derive.
 *   - **Rendezvous connections** — for a fresh offer, and for every persisted
 *     pairing on boot (autoconnect), the daemon dials the rendezvous *outbound*
 *     (`side=daemon&t=<route>`), runs `daemonHandshakeOverSink` with the P1
 *     crypto, and — on success — serves the spliced, E2E-wrapped channel exactly
 *     like `serve --connect` serves a tunnel host. The serving path itself is
 *     injected (`serve`) so this module stays free of pty/adapter concerns and
 *     the CLI can reuse its `createTunnelServer` config verbatim.
 *   - **Reconnect epochs** — a persisted pairing's standing connection parks on
 *     the pairing-derived route `HKDF(pairRoot, "rv-route"‖epoch)`, rotated per
 *     UTC day. The daemon parks on BOTH the current and previous
 *     epoch tokens so a client whose clock straddles midnight still finds it;
 *     reconnect-with-backoff keeps the standing connection alive.
 *   - **Revocation** — removing a pairing drops its rendezvous connections, so
 *     it can no longer be served. For a grace period (`revokedGraceMs`, default
 *     14 days) the daemon keeps a *tombstone*: it still parks on the pairing's
 *     epoch ROUTES, completes the (daemon-signed) handshake only for a hello
 *     carrying that epoch's AUTH token, and answers with a single E2E-encrypted
 *     `error{code:"pairing_revoked"}` frame before closing — never serving the
 *     channel. That is what lets a client tell "unpaired" from "daemon
 *     offline" (which both otherwise look like a park timeout at the broker)
 *     and stop retrying. The signal is authenticated like every tunnel frame:
 *     it arrives inside the AEAD channel of a handshake whose transcript the
 *     client verified against the pinned daemon key, so the broker can't forge
 *     it; and the broker, which knows the routes, can't elicit it either (no
 *     auth token). A tombstone keeps only the per-epoch route + auth tokens for
 *     its window — the pair root is dropped at revoke.
 *
 * ## Reconnect authentication (why no stable client key)
 *
 * The handshake carries only a client *ephemeral* key (regenerated per
 * handshake) — there is no persistent client identity key. So a reconnect
 * authenticates the client by **possession of the epoch AUTH token**
 * `HKDF(pairRoot, "rv-auth"‖epoch)`, which derives from `pairRoot` — a secret
 * only the paired client and daemon share (it fell out of the original ECDH).
 * The daemon parks on the pairing's epoch ROUTE, and on that connection the
 * `verifyAuthToken` predicate accepts a hello whose sealed auth equals the same
 * epoch's auth token (constant-time). The route and auth are separate one-way
 * HKDF outputs: the broker sees every route and can't compute an auth from it.
 * (pair/v1 used ONE value for both, so a broker could replay a logged route as
 * the proof and be served.) The stored `fingerprint` (of the first handshake's
 * ephemeral key) is a stable display/revocation handle, not an auth input.
 *
 * ## Legacy (pair/v1) pairings
 *
 * A v1 `pairings.json` is loaded with every record flagged `legacy`: listed and
 * revocable, never served. The daemon still parks on a legacy pairing's routes
 * (the epoch route is unchanged from v1) so that pairing's not-yet-upgraded
 * client reaches it and is told to re-pair — see `respondToLegacyHandshake` —
 * rather than timing out. v1 records are not upgraded in place: v1 let the
 * broker pair as a client, so any v1 record may be the broker's own.
 */

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, basename } from "node:path"
import {
  daemonHandshakeOverSink,
  type ErrorFrame,
  type FrameSink,
  type E2eFrameSink,
} from "@agentproto/acp/tunnel"
import {
  decodePairingHello,
  encodePairingMessage,
  respondToHandshake,
  respondToLegacyHandshake,
  derivePairRoot,
  deriveEpochTokens,
  deriveOfferTokens,
  currentEpoch,
  encodeOfferUrl,
  HOSTED_RENDEZVOUS_URL,
  OFFER_VERSION,
  PAIRING_PROTOCOL_OUTDATED_MESSAGE,
  PairingError,
  type RouteAuthTokens,
} from "@agentproto/secrets/pairing"
import {
  identityFingerprint,
  type DaemonIdentity,
} from "@agentproto/secrets/identity"
import { createReconnectLogGate } from "./reconnect-log-gate.js"

/** `pairings.json` format. v2 = pairings made under pair/v2 (route/auth
 *  split). A v1 file still loads, every record flagged `legacy`. */
export const PAIRINGS_VERSION = 2 as const
const LEGACY_PAIRINGS_VERSION = 1

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
  /** Set on a pairing made under the retired pair/v1 protocol: listed and
   *  revocable, never served — its client is told to re-pair. */
  legacy?: true
}

/** A revoked pairing still answered with `pairing_revoked` until `expiresAt`
 *  (see "Revocation" above). Persisted in `pairings.json` under `revoked`. */
export interface RevokedPairingRecord {
  /** The revoked pairing's fingerprint. */
  fingerprint: string
  /** Its client label. */
  name: string
  /** Rendezvous endpoint its client reconnects through. */
  rendezvousUrl: string
  /** ISO-8601 revocation time. */
  revokedAt: string
  /** ISO-8601 end of the grace window; the tombstone is dropped after it. */
  expiresAt: string
  /** The epoch route (parked on) + auth (verified) tokens covering the window
   *  (previous epoch at revoke time through the epoch of `expiresAt`) —
   *  derived from the pair root at revoke time so the root itself need not be
   *  kept. */
  routes: ({ epoch: number } & RouteAuthTokens)[]
}

interface PairingsFile {
  v: typeof PAIRINGS_VERSION | typeof LEGACY_PAIRINGS_VERSION
  pairings: PairingRecord[]
  /** Tombstones of revoked pairings (absent in files written before them;
   *  ignored by daemons that predate them). */
  revoked?: RevokedPairingRecord[]
}

/** The tunnel `error` code a revoked pairing's client receives. */
export const PAIRING_REVOKED_CODE = "pairing_revoked" as const

function revokedFrame(): ErrorFrame {
  return {
    t: "error",
    code: PAIRING_REVOKED_CODE,
    message: "this device was unpaired from the daemon (agentproto pair revoke); pair again with a new offer",
  }
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
  /** The one-time offer secret (base64url) — the URL's `s`. Never on the wire:
   *  the broker only ever sees its derived route. */
  secret: string
  /** Offer expiry, unix seconds. */
  exp: number
  /** The full `agentproto://pair?…` offer URL. */
  url: string
  /** The daemon's identity fingerprint (shown to the human at accept time). */
  fingerprint: string
  /** The rendezvous the offer routes through. */
  rendezvousUrl: string
  /** True when `rendezvousUrl` is the hosted default — i.e. neither an explicit
   *  `--rendezvous` nor a configured `pairing.rendezvous` applied, so the offer
   *  falls back to `HOSTED_RENDEZVOUS_URL`. Surfaced so `pair offer` can flag,
   *  never silently, that the daemon is relaying through our infrastructure. */
  rendezvousIsHostedDefault: boolean
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
  /** Configured rendezvous URL (from `config.pairing.rendezvous`). Three states:
   *  - `undefined` (key absent) → `createOffer` falls back to the hosted default
   *    (`HOSTED_RENDEZVOUS_URL`).
   *  - a non-empty URL → that endpoint is the default for offers.
   *  - `""` (explicitly empty) → an explicit opt-out: no default applies, so an
   *    offer without `--rendezvous` fails closed. Wire it through verbatim (do
   *    not coerce `""` to `undefined`) or the opt-out silently reverts to the
   *    hosted default. */
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
  /** How long a revoked pairing is still answered with `pairing_revoked` (see
   *  "Revocation" above). Default 14 days; `0` disables tombstones, so a
   *  revoked client just stops finding the daemon. */
  revokedGraceMs?: number
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
const DEFAULT_REVOKED_GRACE_MS = 14 * 86_400_000

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
  /** Broker route derived from the offer secret (the map key). */
  route: string
  /** Auth token derived from the offer secret; the sealed hello must carry it. */
  auth: string
  exp: number // unix seconds
  spent: boolean
  rendezvousUrl: string
}

/** Re-pair notice sent (E2E, inside a completed v1 channel) to a pair/v1
 *  client. A v1 client drops tunnel-level `error` frames and only surfaces a
 *  `hello` whose `version` it doesn't speak — as "Tunnel daemon speaks
 *  <version>; client speaks …" — so the notice rides in that field too. */
const OUTDATED_HELLO_VERSION = `pair/v2 required — ${PAIRING_PROTOCOL_OUTDATED_MESSAGE}`

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
  const revokedGraceMs = deps.revokedGraceMs ?? DEFAULT_REVOKED_GRACE_MS

  // Rate-limit dial-failure logging per loop key. A revoked/offline peer's
  // standing reconnect re-dials forever; without this a single dead pairing
  // buries daemon.log (it was ~85% of one 2.9MB log). First failure logs at
  // once, then at most one line per window carrying the suppressed count;
  // a successful dial resets the key. Backoff/timing is unchanged.
  const dialFailureGate = createReconnectLogGate({ now })

  /** fingerprint → record. Source of truth in memory; disk is the mirror. */
  const pairings = new Map<string, PairingRecord>()
  /** fingerprint → tombstone of a revoked pairing (see "Revocation"). */
  const revoked = new Map<string, RevokedPairingRecord>()
  /** route → offer. */
  const offers = new Map<string, OfferEntry>()
  /** Loops keyed for lifecycle: `offer:<route>` and `pair:<fp>:<slot>`. Keys
   *  reach the log, so they carry the (public) route, never a secret. */
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
        const fromV1 = parsed.v === LEGACY_PAIRINGS_VERSION
        for (const rec of parsed.pairings) {
          pairings.set(rec.fingerprint, fromV1 ? { ...rec, legacy: true } : rec)
        }
        for (const rec of parsed.revoked ?? []) {
          if (isRevokedRecord(rec) && tombstoneLive(rec)) revoked.set(rec.fingerprint, rec)
        }
        const legacy = Array.from(pairings.values()).filter(r => r.legacy)
        if (legacy.length > 0) {
          log(
            `[pairing] ${legacy.length} pairing(s) in ${pairingsPath} use the retired pair/v1 ` +
              `protocol and will not be served (${legacy.map(r => r.name).join(", ")}). ` +
              "Re-pair each client — run `agentproto pair offer` — then " +
              "`agentproto pair revoke <name>` the legacy entry.",
          )
        }
      } else {
        log(`[pairing] ignoring ${pairingsPath}: unrecognised format`)
      }
    } catch (err) {
      if (!isEnoent(err)) {
        log(`[pairing] could not read ${pairingsPath}: ${errMsg(err)}`)
      }
    }
  }

  async function persist(): Promise<void> {
    for (const [fp, rec] of revoked) if (!tombstoneLive(rec)) revoked.delete(fp)
    const file: PairingsFile = {
      v: PAIRINGS_VERSION,
      pairings: Array.from(pairings.values()),
      ...(revoked.size > 0 ? { revoked: Array.from(revoked.values()) } : {}),
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
    /** Route (dialled) + auth (verified) tokens for this iteration —
     *  recomputed for epoch loops; the derivation is async. */
    tokens: () => RouteAuthTokens | Promise<RouteAuthTokens>
    /** Verify the auth token presented in the sealed hello against this
     *  iteration's `tokens()`. Must be constant-time. */
    verify: (presented: string, expected: RouteAuthTokens) => boolean
    /** Whether to stop after the first successful serve (offers) vs. loop
     *  forever re-parking (reconnect). */
    singleUse: boolean
    /** Should the loop keep running? (e.g. offer not yet expired/spent, or the
     *  pairing still exists). Checked at the top of each iteration. */
    shouldContinue: () => boolean
    /** Set for a revoked pairing's tombstone: after the handshake, send this
     *  frame and close instead of serving (`onPaired` is not called). */
    reject?: ErrorFrame
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

  async function stopLoop(key: string, reason?: typeof REVOKED): Promise<void> {
    const loop = loops.get(key)
    if (!loop) return
    loops.delete(key)
    loop.abort.abort(reason)
    await loop.done.catch(() => {})
  }

  async function runLoop(spec: LoopSpec, signal: AbortSignal): Promise<void> {
    let backoff = reconnectMinMs
    while (!signal.aborted && spec.shouldContinue()) {
      const expected = await spec.tokens()
      let sink: FrameSink
      try {
        sink = await deps.dial(dialUrl(spec.rendezvousUrl, expected.route), signal)
      } catch (err) {
        if (signal.aborted) break
        const line = dialFailureGate.onFailure(
          spec.key,
          `[pairing] dial ${spec.key} failed: ${errMsg(err)}`,
        )
        if (line) log(line)
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, reconnectMaxMs)
        continue
      }
      // A socket the broker refused on arrival (e.g. `token_in_use` while the
      // previous splice on this route is still tearing down) can come back
      // already closed: its close event fired before we could subscribe, so the
      // handshake would sit out its whole timeout. Treat it as a failed dial.
      if (!sink.isOpen) {
        if (signal.aborted) break
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, reconnectMaxMs)
        continue
      }
      // Dial succeeded — clear any accumulated suppression for this key so the
      // next outage logs its first failure promptly.
      dialFailureGate.onSuccess(spec.key)

      // Make the in-flight handshake abortable: closing the sink on shutdown
      // makes `daemonHandshakeOverSink` reject promptly (transport closed),
      // instead of blocking on its own timeout for up to handshakeTimeoutMs.
      let serving = false
      const onAbort = (): void => {
        // A revoke of a live channel is handled by waitClosed, which tells the
        // client before closing — closing the raw socket here would drop that.
        if (serving && signal.reason === REVOKED) return
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
        let legacyPeer = false
        let wrapped: E2eFrameSink
        try {
          const identity = await deps.loadIdentity()
          wrapped = await daemonHandshakeOverSink(
            sink,
            async helloBytes => {
              let hello: import("@agentproto/secrets/pairing").PairingHello
              try {
                hello = decodePairingHello(helloBytes)
              } catch (err) {
                if (!(err instanceof PairingError) || err.code !== "pairing_protocol_outdated") throw err
                // A pair/v1 client: complete ITS handshake only to tell it to
                // re-pair. No auth is checked and nothing is served.
                legacyPeer = true
                return respondToLegacyHandshake(helloBytes, identity)
              }
              const result = await respondToHandshake(hello, {
                identity,
                verifyAuthToken: presented => spec.verify(presented, expected),
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

        if (legacyPeer) {
          sendOutdatedNotice(wrapped)
          log(`[pairing] told a pair/v1 client on ${spec.key} to re-pair`)
          // Not a success: keep backing off so a v1 client (or anyone replaying
          // a v1 hello) can't spin this loop.
          await sleep(backoff, signal)
          backoff = Math.min(backoff * 2, reconnectMaxMs)
          continue
        }

        backoff = reconnectMinMs // success resets

        if (!capturedSession || !capturedHello) {
          wrapped.close("internal: missing session")
          continue
        }

        if (spec.reject) {
          // Tombstone: the client proved possession of a revoked pairing's
          // epoch AUTH token and verified our signature — tell it, inside the
          // AEAD channel, that it is unpaired. Never served. `close` flushes
          // the frame first.
          wrapped.send(spec.reject)
          wrapped.close(spec.reject.code)
          log(`[pairing] refused revoked pairing via ${spec.key}`)
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

        serving = true
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
    // Precedence (PLAN deliverable 2): `--rendezvous` flag → `pairing.rendezvous`
    // in config → hosted default. A configured empty string is an explicit
    // opt-out (deliverable 4b): no default applies, so an offer without an
    // explicit `--rendezvous` fails closed — the reachable form of the branch
    // that used to fire whenever nothing was configured.
    let rendezvousUrl: string
    let rendezvousIsHostedDefault = false
    if (input.rendezvousUrl) {
      rendezvousUrl = input.rendezvousUrl
    } else if (deps.defaultRendezvousUrl !== undefined) {
      if (deps.defaultRendezvousUrl === "") {
        throw new PairingError(
          "malformed_offer",
          'rendezvous disabled — pairing.rendezvous is set to "" (explicit opt-out); ' +
            "pass --rendezvous to route this offer through a specific broker",
        )
      }
      rendezvousUrl = deps.defaultRendezvousUrl
    } else {
      rendezvousUrl = HOSTED_RENDEZVOUS_URL
      rendezvousIsHostedDefault = true
    }
    const identity = await deps.loadIdentity()
    const secret = b64url(randomBytes(16))
    const { route, auth } = await deriveOfferTokens(secret)
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
    const exp = Math.floor((now() + ttlMs) / 1000)
    offers.set(route, { route, auth, exp, spent: false, rendezvousUrl })

    const fingerprint = await identityFingerprint(identity.x25519.pub)
    const url = encodeOfferUrl({
      v: OFFER_VERSION,
      rendezvousUrl,
      fingerprint,
      daemonX25519Pub: identity.x25519.pub,
      daemonEd25519Pub: identity.ed25519.pub,
      secret,
      exp,
    })

    startOfferLoop({ route, auth }, rendezvousUrl)
    log(
      `[pairing] offer minted (exp ${new Date(exp * 1000).toISOString()}) via ${rendezvousUrl}` +
        (rendezvousIsHostedDefault ? " (hosted default)" : ""),
    )
    return { secret, exp, url, fingerprint, rendezvousUrl, rendezvousIsHostedDefault }
  }

  function offerValid(route: string): boolean {
    const entry = offers.get(route)
    return !!entry && !entry.spent && entry.exp * 1000 > now()
  }

  function startOfferLoop(tokens: RouteAuthTokens, rendezvousUrl: string): void {
    const { route } = tokens
    startLoop({
      key: `offer:${route}`,
      rendezvousUrl,
      tokens: () => tokens,
      shouldContinue: () => offerValid(route),
      singleUse: true,
      verify: presented => {
        const entry = offers.get(route)
        if (!entry || entry.spent || entry.exp * 1000 <= now()) return false
        // The AUTH token, never the route: the broker knows the route.
        if (!constantTimeEqual(presented, entry.auth)) return false
        entry.spent = true // SPEND — single use, and only on a correct auth
        return true
      },
      onPaired: async (session, hello) => {
        const pairRoot = await derivePairRoot(session)
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
        revoked.delete(fingerprint)
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
        tokens: () => deriveEpochTokens(record.pairRoot, epochOf()),
        shouldContinue: () => pairings.has(record.fingerprint),
        singleUse: false,
        // A legacy (v1) pairing is parked on only so its client can be told to
        // re-pair; it never authenticates, whatever it presents.
        verify: (presented, expected) =>
          !record.legacy && constantTimeEqual(presented, expected.auth),
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

  function startTombstoneLoops(rec: RevokedPairingRecord): void {
    for (const slot of ["cur", "prev"] as const) {
      const epochOf = () => (slot === "cur" ? currentEpoch(now()) : currentEpoch(now()) - 1)
      const tokensFor = () => rec.routes.find(r => r.epoch === epochOf())
      startLoop({
        key: `revoked:${rec.fingerprint}:${slot}`,
        rendezvousUrl: rec.rendezvousUrl,
        tokens: () => tokensFor() ?? { route: "", auth: "" },
        shouldContinue: () =>
          revoked.get(rec.fingerprint) === rec && tombstoneLive(rec) && tokensFor() !== undefined,
        singleUse: false,
        // The AUTH token, never the route: the broker knows every route, and a
        // tombstone must not become a way for it to probe revocation state.
        verify: (presented, expected) => expected.auth !== "" && constantTimeEqual(presented, expected.auth),
        reject: revokedFrame(),
        onPaired: async () => {
          throw new Error("unreachable: a tombstone never serves")
        },
      })
    }
  }

  function tombstoneLive(rec: RevokedPairingRecord): boolean {
    return Date.parse(rec.expiresAt) > now()
  }

  async function startAutoconnect(): Promise<void> {
    await ensureLoaded()
    for (const record of pairings.values()) {
      startReconnectLoops(record)
    }
    for (const rec of revoked.values()) {
      startTombstoneLoops(rec)
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
    let tombstone: RevokedPairingRecord | null = null
    // No tombstone for a legacy (v1) pairing: its client can only be told to
    // re-pair (see "Legacy"), which a v1 client can't act on as "revoked".
    if (revokedGraceMs > 0 && !target.legacy) {
      const at = now()
      const expiresAt = at + revokedGraceMs
      const routes: RevokedPairingRecord["routes"] = []
      for (let e = currentEpoch(at) - 1; e <= currentEpoch(expiresAt); e++) {
        routes.push({ epoch: e, ...(await deriveEpochTokens(target.pairRoot, e)) })
      }
      tombstone = {
        fingerprint: target.fingerprint,
        name: target.name,
        rendezvousUrl: target.rendezvousUrl,
        revokedAt: new Date(at).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        routes,
      }
      revoked.set(target.fingerprint, tombstone)
    }
    await persist()
    // Stop serving/parking on this pairing's tokens. A live channel is told
    // `pairing_revoked` before it closes (see waitClosed).
    await stopLoop(`pair:${target.fingerprint}:cur`, REVOKED)
    await stopLoop(`pair:${target.fingerprint}:prev`, REVOKED)
    if (tombstone) startTombstoneLoops(tombstone)
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

/** Tell a pair/v1 peer to re-pair, over the notice-only channel, then close. */
function sendOutdatedNotice(sink: E2eFrameSink): void {
  sink.send({ t: "error", code: "pairing_protocol_outdated", message: PAIRING_PROTOCOL_OUTDATED_MESSAGE })
  sink.send({
    t: "hello",
    // Deliberately not TUNNEL_VERSION: a v1 client reports an unknown version
    // verbatim, which is how the notice reaches its user (see
    // OUTDATED_HELLO_VERSION).
    version: OUTDATED_HELLO_VERSION as "agentproto/tunnel/v1",
    capabilities: { pty: false },
    label: "pairing_protocol_outdated",
  })
  // close() flushes already-queued frames before closing the transport.
  sink.close("pairing_protocol_outdated")
}

/** Abort reason for a loop stopped by `revoke` — its live channel, if any, is
 *  told `pairing_revoked` before it closes. */
const REVOKED = Symbol("pairing revoked")

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
      if (signal.reason === REVOKED) {
        sink.send(revokedFrame())
        sink.close(PAIRING_REVOKED_CODE)
      } else {
        sink.close("registry shutdown")
      }
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
  if (rec["v"] !== PAIRINGS_VERSION && rec["v"] !== LEGACY_PAIRINGS_VERSION) return false
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

function isRevokedRecord(v: unknown): v is RevokedPairingRecord {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r["fingerprint"] === "string" &&
    typeof r["name"] === "string" &&
    typeof r["rendezvousUrl"] === "string" &&
    typeof r["revokedAt"] === "string" &&
    typeof r["expiresAt"] === "string" &&
    Array.isArray(r["routes"]) &&
    r["routes"].every(x => {
      if (typeof x !== "object" || x === null) return false
      const t = x as Record<string, unknown>
      return typeof t["epoch"] === "number" && typeof t["route"] === "string" && typeof t["auth"] === "string"
    })
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
