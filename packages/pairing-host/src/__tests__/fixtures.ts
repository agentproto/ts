/**
 * Test fixtures: an in-memory rendezvous fake (a registry-side `dial` plus a
 * client-side dial that meets it by route token) and the client half of the
 * pair/v2 handshake. Not a test file.
 */

import { vi } from "vitest"
import {
  createTunnelClient,
  clientHandshakeOverSink,
  type FrameSink,
  type TunnelClient,
} from "@agentproto/acp/tunnel"
import {
  startClientHandshake,
  encodePairingMessage,
  decodePairingReply,
  parseOfferUrl,
  deriveOfferTokens,
  deriveEpochTokens,
  currentEpoch,
  derivePairRoot,
  type PairingSession,
} from "@agentproto/secrets/pairing"
import { connect } from "./frame-harness.js"

export class FakeRendezvous {
  /** route token → host-side ends still parked, waiting for a client. */
  private parked = new Map<string, FrameSink[]>()
  private clientEnds = new Map<FrameSink, FrameSink>()
  readonly dialedUrls: string[] = []

  /** `PairingRegistryDeps.dial`: parks the host end under its route token. */
  dial = async (url: string): Promise<FrameSink> => {
    this.dialedUrls.push(url)
    const token = new URL(url).searchParams.get("t")
    if (!token) throw new Error("fake rendezvous: no route token")
    const { a, b } = connect()
    const list = this.parked.get(token) ?? []
    list.push(b)
    this.parked.set(token, list)
    this.clientEnds.set(b, a)
    return b
  }

  /** The client's dial: waits for a live host end on `route`, splices. */
  async dialClient(route: string): Promise<FrameSink> {
    let end: FrameSink | undefined
    await vi.waitFor(() => {
      const list = this.parked.get(route) ?? []
      end = list.find(s => s.isOpen)
      if (!end) throw new Error(`nothing parked on ${route}`)
    })
    const host = end as FrameSink
    this.parked.set(route, (this.parked.get(route) ?? []).filter(s => s !== host))
    return this.clientEnds.get(host) as FrameSink
  }
}

export async function acceptHandshake(
  raw: FrameSink,
  daemonX25519Pub: string,
  daemonEd25519Pub: string,
  authToken: string,
  name: string,
): Promise<{ client: TunnelClient; session: PairingSession }> {
  const started = await startClientHandshake({ daemonX25519Pub, daemonEd25519Pub, authToken, clientName: name })
  let session: PairingSession | null = null
  const wrapped = await clientHandshakeOverSink(
    raw,
    encodePairingMessage(started.hello),
    async replyBytes => {
      session = await started.complete(decodePairingReply(replyBytes))
      return session
    },
    { timeoutMs: 3_000 },
  )
  if (!session) throw new Error("handshake did not derive a session")
  return { client: createTunnelClient({ sink: wrapped }), session }
}

/** Client side of `pair accept` over the fake rendezvous. */
export async function pairViaOffer(
  rv: FakeRendezvous,
  offerUrl: string,
  name: string,
): Promise<{ client: TunnelClient; pairRoot: string; daemon: { x: string; ed: string } }> {
  const parsed = await parseOfferUrl(offerUrl)
  const tokens = await deriveOfferTokens(parsed.secret)
  const raw = await rv.dialClient(tokens.route)
  const { client, session } = await acceptHandshake(
    raw,
    parsed.daemonX25519Pub,
    parsed.daemonEd25519Pub,
    tokens.auth,
    name,
  )
  return {
    client,
    pairRoot: await derivePairRoot(session),
    daemon: { x: parsed.daemonX25519Pub, ed: parsed.daemonEd25519Pub },
  }
}

/** Client side of a reconnect: epoch route to dial, epoch auth to prove. */
export async function reconnect(
  rv: FakeRendezvous,
  pairRoot: string,
  daemon: { x: string; ed: string },
  name: string,
): Promise<TunnelClient> {
  const epoch = await deriveEpochTokens(pairRoot, currentEpoch())
  const raw = await rv.dialClient(epoch.route)
  const { client } = await acceptHandshake(raw, daemon.x, daemon.ed, epoch.auth, name)
  return client
}
