/**
 * First contact: turn an offer (the `pair offer --qr` link, or the plain
 * `agentproto://pair?…` URL) into a stored credential.
 *
 * Two steps so a UI can ask the human before persisting anything:
 *
 *   1. `inspectOffer(url)` — no network: parse + validate the offer and return
 *      the daemon fingerprint it pins and when it expires.
 *   2. `pairFromOffer(url)` — run the handshake through the offer's rendezvous
 *      (this spends the one-time offer; the daemon records the pairing now,
 *      exactly as for `agentproto pair accept`), read the daemon's hello for its
 *      name, close the channel, and hand back `{ daemon, confirm, cancel }`.
 *      `confirm()` builds the credential (pair root as a non-extractable
 *      `CryptoKey`) and stores it; `cancel()` drops it. Cancelling does not undo
 *      the daemon's record — remove that with `agentproto pair revoke`.
 */

import {
  derivePairRoot,
  deriveOfferTokens,
  importPairRootKey,
  parseOfferUrl,
  PAIR_VERSION,
  PairingError,
  type PairingOffer,
} from "@agentproto/secrets/pairing/browser"
import {
  daemonNameFromHello,
  defaultWebSocket,
  openChannel,
  type ChannelTimeouts,
  type WebSocketConstructor,
} from "./channel.js"
import type { CredentialStore, PairCredential } from "./credential.js"
import { errMsg, outdatedError, TunnelClientError } from "./errors.js"

export interface OfferInfo {
  /** Daemon identity fingerprint (16 hex) the offer pins — show it to the user. */
  fingerprint: string
  /** The rendezvous the handshake will go through. */
  rendezvousUrl: string
  /** Offer expiry. */
  expiresAt: Date
}

async function parse(offerUrl: string, now: number): Promise<PairingOffer> {
  try {
    return await parseOfferUrl(offerUrl, { now })
  } catch (err) {
    if (err instanceof PairingError && err.code === "pairing_protocol_outdated") {
      throw outdatedError("this pairing QR", { cause: err })
    }
    const expired = err instanceof PairingError && err.code === "offer_expired"
    throw new TunnelClientError(
      "invalid_offer",
      expired ? "this pairing offer has expired; run `agentproto pair offer --qr` again" : errMsg(err),
      { cause: err },
    )
  }
}

/** Parse and validate an offer without touching the network. Accepts the web
 *  form (`https://…/pair#…`) and the `agentproto://pair?…` form. */
export async function inspectOffer(
  offerUrl: string,
  opts: { now?: number } = {},
): Promise<OfferInfo> {
  const offer = await parse(offerUrl, opts.now ?? Date.now())
  return {
    fingerprint: offer.fingerprint,
    rendezvousUrl: offer.rendezvousUrl,
    expiresAt: new Date(offer.exp * 1000),
  }
}

export interface PairFromOfferOptions extends ChannelTimeouts {
  /** How this device is listed on the daemon (`agentproto pair ls`).
   *  Default `browser@<location.host>` (or `browser`). */
  clientName?: string
  /** Where `confirm()` stores the credential. Omit to only get it back. */
  store?: CredentialStore
  /** WebSocket constructor. Default: the global `WebSocket`. */
  WebSocket?: WebSocketConstructor
  /** Clock (ms). Default `Date.now`. */
  now?: () => number
}

export interface PairedDaemon {
  /** Daemon identity fingerprint — verified by the handshake. */
  fingerprint: string
  /** Display name (hello label, else host name, else the fingerprint). */
  name: string
  /** The daemon's `serve --label`, if any. */
  label?: string
  /** `<os>/<hostname>` from the daemon's hello (diagnostic). */
  platform?: string
  rendezvousUrl: string
}

export interface PendingPairing {
  daemon: PairedDaemon
  /** Build the credential and (with `opts.store`) persist it. */
  confirm(): Promise<PairCredential>
  /** Discard the pairing on this side. */
  cancel(): void
}

function defaultClientName(): string {
  const host = (globalThis as { location?: { host?: string } }).location?.host
  return host ? `browser@${host}` : "browser"
}

/**
 * Run the `pair/v1` handshake for an offer. See the module doc for the
 * two-step flow. Throws `TunnelClientError` — `invalid_offer` for a
 * malformed/expired offer, `pairing_failed` for everything the handshake can
 * hit (unreachable daemon, spent offer, bad signature, fingerprint mismatch).
 */
export async function pairFromOffer(
  offerUrl: string,
  opts: PairFromOfferOptions = {},
): Promise<PendingPairing> {
  const now = opts.now ?? Date.now
  const offer = await parse(offerUrl, now())
  const clientName = opts.clientName ?? defaultClientName()

  let channel: Awaited<ReturnType<typeof openChannel>>
  try {
    // The offer secret never goes on the wire: the broker gets its route, the
    // daemon (sealed) its auth.
    const { route, auth } = await deriveOfferTokens(offer.secret)
    channel = await openChannel({
      rendezvousUrl: offer.rendezvousUrl,
      route,
      auth,
      daemonX25519Pub: offer.daemonX25519Pub,
      daemonEd25519Pub: offer.daemonEd25519Pub,
      clientName,
      WebSocket: opts.WebSocket ?? defaultWebSocket(),
      ...(opts.dialTimeoutMs !== undefined ? { dialTimeoutMs: opts.dialTimeoutMs } : {}),
      ...(opts.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: opts.handshakeTimeoutMs } : {}),
      ...(opts.greetingTimeoutMs !== undefined ? { greetingTimeoutMs: opts.greetingTimeoutMs } : {}),
    })
  } catch (err) {
    throw new TunnelClientError("pairing_failed", `could not pair with daemon ${offer.fingerprint}: ${errMsg(err)}`, {
      cause: err,
    })
  }
  const { sink, session, greeting } = channel

  // Defence in depth, as the CLI: the daemon we authenticated must be the one
  // the offer named (parseOfferUrl already checked id == fingerprint(pk)).
  if (session.peerFingerprint !== offer.fingerprint) {
    sink.close("fingerprint mismatch")
    throw new TunnelClientError(
      "pairing_failed",
      `daemon fingerprint ${session.peerFingerprint} does not match the offer's ${offer.fingerprint}`,
    )
  }
  if (greeting.kind === "outdated") {
    sink.close("outdated")
    throw outdatedError("this daemon")
  }
  let pairRoot: string | null = await derivePairRoot(session)
  // The first-contact channel is one-shot, as with `pair accept`.
  sink.close("pair complete")

  const hello = greeting.kind === "hello" ? greeting.hello : null
  const daemon: PairedDaemon = {
    fingerprint: offer.fingerprint,
    name: daemonNameFromHello(hello, offer.fingerprint),
    ...(hello?.label ? { label: hello.label } : {}),
    ...(hello?.daemon?.platform ? { platform: hello.daemon.platform } : {}),
    rendezvousUrl: offer.rendezvousUrl,
  }

  return {
    daemon,
    async confirm() {
      const root = pairRoot
      if (root === null) throw new TunnelClientError("cancelled", "this pairing was already confirmed or cancelled")
      pairRoot = null
      const nowIso = new Date(now()).toISOString()
      const credential: PairCredential = {
        protocol: PAIR_VERSION,
        id: offer.fingerprint,
        fingerprint: offer.fingerprint,
        name: daemon.name,
        clientName,
        daemonX25519Pub: offer.daemonX25519Pub,
        daemonEd25519Pub: offer.daemonEd25519Pub,
        rendezvousUrl: offer.rendezvousUrl,
        pairRoot: await importPairRootKey(root),
        createdAt: nowIso,
        lastSeen: nowIso,
      }
      await opts.store?.put(credential)
      return credential
    },
    cancel() {
      pairRoot = null
    },
  }
}
