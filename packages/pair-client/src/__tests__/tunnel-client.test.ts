/**
 * The browser tunnel client against the real Node daemon side, through a real
 * local rendezvous broker, over the WHATWG `WebSocket` global with WebCrypto
 * (the only crypto the browser entries default to).
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import {
  currentEpoch,
  deriveEpochTokens,
  deriveOfferTokens,
  encodeOfferWebUrl,
  parseOfferUrl,
} from "@agentproto/secrets/pairing"
import { connect, type TunnelClient, type StateChange } from "../client.js"
import { createMemoryCredentialStore, type PairCredential } from "../credential.js"
import { TunnelClientError } from "../errors.js"
import { inspectOffer, pairFromOffer } from "../pair.js"
import { bigBody, countingWebSocket, readAll, sha256, startDaemon, type Daemon } from "./harness.js"

const FAST = { reconnectMinMs: 50, reconnectMaxMs: 200, handshakeTimeoutMs: 3_000, greetingTimeoutMs: 3_000 }

let daemon: Daemon | null = null
const clients: TunnelClient[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await daemon?.teardown()
  daemon = null
})

async function pairedClient(
  opts: { label?: string } = {},
): Promise<{ d: Daemon; credential: PairCredential; client: TunnelClient; sockets: WebSocket[] }> {
  const d = await startDaemon(opts)
  daemon = d
  const { WebSocket, sockets } = countingWebSocket()
  const pending = await pairFromOffer(await d.offer(), { WebSocket, clientName: "phone@test" })
  const credential = await pending.confirm()
  await vi.waitFor(() => expect(d.rendezvous.stats.parked).toBeGreaterThanOrEqual(1))
  const client = connect(credential, { WebSocket, ...FAST })
  clients.push(client)
  await client.ready()
  return { d, credential, client, sockets }
}

describe("pairFromOffer", () => {
  it("pairs from the web-form offer, shows the daemon before storing, and stores a non-extractable root", async () => {
    const d = await startDaemon({ label: "studio-mac" })
    daemon = d
    const offerUrl = encodeOfferWebUrl(await d.offer())
    expect(offerUrl.startsWith("https://cli.agentproto.sh/pair#")).toBe(true)

    // Step 0: no network — what the page can show straight from the QR.
    const info = await inspectOffer(offerUrl)
    expect(info.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(info.expiresAt.getTime()).toBeGreaterThan(Date.now())

    const store = createMemoryCredentialStore()
    const { WebSocket } = countingWebSocket()
    const pending = await pairFromOffer(offerUrl, { WebSocket, store, clientName: "phone@test" })
    expect(pending.daemon).toMatchObject({ fingerprint: info.fingerprint, name: "studio-mac", label: "studio-mac" })
    // Nothing stored until the human confirms.
    expect(await store.list()).toEqual([])

    const credential = await pending.confirm()
    expect(await store.get(info.fingerprint)).toBe(credential)
    expect(credential).toMatchObject({
      id: info.fingerprint,
      fingerprint: info.fingerprint,
      name: "studio-mac",
      clientName: "phone@test",
      rendezvousUrl: d.rvUrl,
    })
    const root = credential.pairRoot as CryptoKey
    expect(root.extractable).toBe(false)
    expect(root.algorithm.name).toBe("HKDF")
    await expect(pending.confirm()).rejects.toMatchObject({ code: "cancelled" })

    // The daemon recorded this device exactly as it records `pair accept`.
    await vi.waitFor(async () => expect(await d.registry.list()).toHaveLength(1))
    expect((await d.registry.list())[0]!.name).toBe("phone@test")
  }, 30_000)

  it("falls back to the daemon's host name, and rejects a spent or expired offer", async () => {
    const d = await startDaemon()
    daemon = d
    const offerUrl = await d.offer()
    const { WebSocket } = countingWebSocket()
    const pending = await pairFromOffer(offerUrl, { WebSocket })
    expect(pending.daemon.name).not.toBe("")
    expect(pending.daemon.platform).toContain("/")
    pending.cancel()
    await expect(pending.confirm()).rejects.toMatchObject({ code: "cancelled" })

    // The offer is single-use: no daemon parks on it any more.
    await expect(
      pairFromOffer(offerUrl, { WebSocket, handshakeTimeoutMs: 500, dialTimeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "pairing_failed" })
    await expect(pairFromOffer(offerUrl, { WebSocket, now: () => Date.now() + 3_600_000 })).rejects.toMatchObject({
      code: "invalid_offer",
    })
    await expect(inspectOffer("https://cli.agentproto.sh/pair#v=1&t=nope")).rejects.toBeInstanceOf(TunnelClientError)
  }, 30_000)
})

describe("pair/v2 route/auth split", () => {
  it("dials only the ROUTE token; the AUTH token never appears in any URL", async () => {
    const d = await startDaemon()
    daemon = d
    const offerUrl = await d.offer()
    const offer = await parseOfferUrl(offerUrl)
    const offerTokens = await deriveOfferTokens(offer.secret)
    const { WebSocket, sockets } = countingWebSocket()

    const credential = await (await pairFromOffer(offerUrl, { WebSocket, clientName: "phone@test" })).confirm()
    await vi.waitFor(() => expect(d.rendezvous.stats.parked).toBeGreaterThanOrEqual(1))
    const client = connect(credential, { WebSocket, ...FAST })
    clients.push(client)
    await client.ready()
    // Drop the channel once so a reconnect's URL is covered too.
    const states: string[] = []
    client.onStateChange(c => states.push(c.state))
    const dialsBefore = sockets.length
    sockets.at(-1)!.close()
    await vi.waitFor(() => expect(states.at(-1)).toBe("open"))
    expect(states).toContain("offline")
    expect(sockets.length).toBeGreaterThan(dialsBefore)
    expect((await client.fetch("/ping")).status).toBe(200)

    // The pair root never left the key; recompute the tokens daemon-side.
    const pairRoot = (await d.registry.list())[0]!.pairRoot
    const e = currentEpoch()
    const epochTokens = [await deriveEpochTokens(pairRoot, e), await deriveEpochTokens(pairRoot, e - 1)]
    const urls = sockets.map(ws => decodeURIComponent(ws.url))
    expect(urls.length).toBeGreaterThanOrEqual(3)
    const secrets = [offer.secret, offerTokens.auth, ...epochTokens.map(t => t.auth)]
    for (const url of urls) for (const secret of secrets) expect(url).not.toContain(secret)
    // …and every dial carried a route: the offer's first, then an epoch's.
    expect(new URL(urls[0]!).searchParams.get("t")).toBe(offerTokens.route)
    for (const url of urls.slice(1)) {
      expect(epochTokens.map(t => t.route)).toContain(new URL(url).searchParams.get("t"))
    }
  }, 30_000)

  it("a pre-v2 offer or stored credential is a typed protocol_outdated error, never dialed", async () => {
    const d = await startDaemon()
    daemon = d
    const v1Offer = (await d.offer()).replace("v=2", "v=1").replace("&s=", "&t=")
    const { WebSocket, sockets } = countingWebSocket()
    for (const url of [v1Offer, encodeOfferWebUrl(v1Offer)]) {
      const err = await pairFromOffer(url, { WebSocket }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TunnelClientError)
      expect((err as TunnelClientError).code).toBe("protocol_outdated")
      expect((err as TunnelClientError).message).toMatch(/scan a new pairing QR/)
      await expect(inspectOffer(url)).rejects.toMatchObject({ code: "protocol_outdated" })
    }

    // A credential stored before pair/v2 (no `protocol` stamp).
    const { credential } = await pairedClient()
    const { protocol: _v, ...legacy } = credential
    const c = connect(legacy, { WebSocket, ...FAST })
    clients.push(c)
    const changes: StateChange[] = []
    c.onStateChange(change => changes.push(change)) // attached right after connect()
    expect(c.state).toBe("outdated")
    expect(c.lastError?.code).toBe("protocol_outdated")
    await expect(c.ready()).rejects.toMatchObject({ code: "protocol_outdated" })
    await expect(c.fetch("/x")).rejects.toMatchObject({ code: "protocol_outdated" })
    // The listener heard it, once, with the typed error.
    expect(changes.map(x => x.state)).toEqual(["outdated"])
    expect(changes[0]!.error?.code).toBe("protocol_outdated")
    // Terminal: closing the client (page/SW cleanup) keeps the verdict.
    c.close()
    expect(c.state).toBe("outdated")
    expect(c.lastError?.code).toBe("protocol_outdated")
    await new Promise(r => setTimeout(r, 200))
    expect(sockets).toHaveLength(0)
  }, 30_000)

  it("a daemon greeting of pairing_protocol_outdated ends in the terminal 'outdated' state", async () => {
    const d = await startDaemon({ reconnectGreeting: "pairing_protocol_outdated" })
    daemon = d
    const { WebSocket, sockets } = countingWebSocket()
    const credential = await (await pairFromOffer(await d.offer(), { WebSocket })).confirm()
    await vi.waitFor(() => expect(d.rendezvous.stats.parked).toBeGreaterThanOrEqual(1))
    const c = connect(credential, { WebSocket, ...FAST })
    clients.push(c)
    const changes: StateChange[] = []
    c.onStateChange(change => changes.push(change))

    await expect(c.ready()).rejects.toMatchObject({ code: "protocol_outdated" })
    expect(c.state).toBe("outdated")
    expect(c.lastError?.code).toBe("protocol_outdated")
    expect(c.lastError?.message).toMatch(/scan a new pairing QR/)
    expect(changes.at(-1)).toMatchObject({ state: "outdated", error: { code: "protocol_outdated" } })
    await expect(c.fetch("/x")).rejects.toMatchObject({ code: "protocol_outdated" })

    // No retry loop, and close() keeps the verdict.
    const dials = sockets.length
    await new Promise(r => setTimeout(r, 400))
    expect(sockets.length).toBe(dials)
    c.close()
    expect(c.state).toBe("outdated")
  }, 30_000)
})

describe("TunnelClient.fetch", () => {
  it("round-trips status, headers, body and a POST body", async () => {
    const { client, d } = await pairedClient()
    expect(client.state).toBe("open")
    expect(client.hello?.version).toBe("agentproto/tunnel/v1")

    const res = await client.fetch("/sessions?limit=2", { headers: { "x-trace": "abc" } })
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/json")
    expect(res.headers.get("x-upstream")).toBe("yes")
    const echoed = await res.json()
    expect(echoed).toMatchObject({ method: "GET", path: "/sessions?limit=2" })
    expect(echoed.headers["x-trace"]).toBe("abc")

    const post = await client.fetch("https://ignored.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(await post.json()).toMatchObject({
      method: "POST",
      path: "/mcp",
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })

    const binary = new Uint8Array(70_000).map((_, i) => i % 251)
    const put = await client.fetch(new Request("http://x/blob", { method: "PUT", body: binary }))
    expect((await put.json()).body.length).toBeGreaterThan(0)
    expect(d.upstream.requests.at(-1)).toMatchObject({ method: "PUT", path: "/blob" })

    const noContent = await client.fetch("/status/204")
    expect(noContent.status).toBe(204)
    expect(noContent.body).toBeNull()
    expect(noContent.headers.get("x-status")).toBe("204")
    expect((await client.fetch("/status/404")).status).toBe(404)
  }, 30_000)

  it("streams SSE incrementally: the first event is read before the server sends the last", async () => {
    const { client, d } = await pairedClient()
    const res = await client.fetch("/sse", { headers: { accept: "text/event-stream" } })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    expect(res.body).toBeInstanceOf(ReadableStream)

    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    const first = await reader.read()
    expect(dec.decode(first.value)).toBe("event: tick\ndata: 1\n\n")

    // The upstream has NOT sent event 2 yet — it waits for us. Release it now.
    d.upstream.releaseSse()
    let rest = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += dec.decode(value, { stream: true })
    }
    expect(rest).toBe("event: tick\ndata: 2\n\n")
  }, 30_000)

  it("multiplexes concurrent requests over one WebSocket", async () => {
    const { client, sockets } = await pairedClient()
    const dialsBefore = sockets.length
    const delays = [120, 10, 80, 40, 0, 100, 60, 20, 90, 30]
    const t0 = Date.now()
    const results = await Promise.all(
      delays.map(async ms => (await client.fetch(`/slow/${ms}`)).json() as Promise<{ slow: number }>),
    )
    expect(results.map(r => r.slow)).toEqual(delays)
    // Concurrent, not serialized (the delays sum to 550ms).
    expect(Date.now() - t0).toBeLessThan(500)
    expect(sockets.length).toBe(dialsBefore)
  }, 30_000)

  it("abort cancels the stream on the daemon side (http_cancel)", async () => {
    const { client, d } = await pairedClient()
    const ctl = new AbortController()
    const res = await client.fetch("/forever", { signal: ctl.signal })
    const reader = res.body!.getReader()
    await reader.read()
    ctl.abort()
    await expect(reader.read()).rejects.toThrow()
    await d.upstream.foreverCancelled

    // Cancelling the body (what EventSource.close() does) works the same way.
    await expect(client.fetch("/slow/10", { signal: AbortSignal.abort() })).rejects.toThrow()
    const res2 = await client.fetch("/sse")
    await res2.body!.cancel()
    expect((await client.fetch("/ping")).status).toBe(200)
  }, 30_000)
})

describe("TunnelClient over a rendezvous with its default 1 MiB message cap", () => {
  it("round-trips a multi-MB response and a multi-MB POST body intact, on one channel", async () => {
    // The harness broker keeps the default maxMessageBytes (1 MiB), like the
    // hosted rdv.agentproto.sh. One frame per body would be ~1.78x the body
    // on the wire and get the channel closed.
    const { client, d, sockets } = await pairedClient()
    const dials = sockets.length

    // A 1.4 MB single-file page (the session-chat UI case) and a larger one.
    for (const n of [1_400_000, 5 * 1024 * 1024 + 17]) {
      const res = await client.fetch(`/apps/x/ui/big/${n}`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("text/html")
      const got = new Uint8Array(await res.arrayBuffer())
      expect(got.length).toBe(n)
      expect(sha256(got)).toBe(sha256(bigBody(n)))
    }

    const upload = bigBody(4 * 1024 * 1024 + 3, 42)
    const posted = await client.fetch("/digest", { method: "POST", body: upload })
    expect(await posted.json()).toEqual({ length: upload.length, sha256: sha256(upload) })

    // Interleaved with a small request, and still the same live channel.
    const [a, b] = await Promise.all([client.fetch("/big/2000000"), client.fetch("/ping")])
    expect((await a.arrayBuffer()).byteLength).toBe(2_000_000)
    expect(b.status).toBe(200)
    expect(client.state).toBe("open")
    expect(sockets.length).toBe(dials)
    expect(d.rendezvous.stats.active).toBeGreaterThanOrEqual(1)
  }, 60_000)
})

describe("TunnelClient connection lifecycle", () => {
  it("reconnects after the WebSocket drops; in-flight requests fail cleanly, new ones wait", async () => {
    const { client, sockets } = await pairedClient()
    const states: StateChange["state"][] = []
    client.onStateChange(c => states.push(c.state))

    const inflight = await client.fetch("/forever")
    const reader = inflight.body!.getReader()
    await reader.read()

    sockets.at(-1)!.close()
    const err = await reader.read().then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(TunnelClientError)
    expect((err as TunnelClientError).code).toBe("disconnected")

    // Issued while down: waits for the reconnect, then succeeds.
    const res = await client.fetch("/after-reconnect")
    expect(res.status).toBe(200)
    expect(client.state).toBe("open")
    expect(states).toContain("offline")
    expect(states.at(-1)).toBe("open")
  }, 30_000)

  it("revoke → a typed, actionable error, and no retry loop", async () => {
    const { client, d, credential, sockets } = await pairedClient({ label: "studio-mac" })
    const states: StateChange[] = []
    client.onStateChange(c => states.push(c))

    // Revoked while connected: the daemon says so on the live channel.
    await d.registry.revoke((await d.registry.list())[0]!.fingerprint)
    await vi.waitFor(() => expect(client.state).toBe("revoked"))
    expect(client.lastError?.code).toBe("revoked")
    expect(client.lastError?.message).toBe("this device was unpaired from studio-mac; scan a new pairing QR")
    const fetchErr = await client.fetch("/x").catch((e: unknown) => e)
    expect(fetchErr).toBeInstanceOf(TunnelClientError)
    expect((fetchErr as TunnelClientError).code).toBe("revoked")
    await expect(client.ready()).rejects.toMatchObject({ code: "revoked" })

    // Terminal: no more dials.
    const dials = sockets.length
    await new Promise(r => setTimeout(r, 600))
    expect(sockets.length).toBe(dials)
    expect(states.map(s => s.state)).toEqual(["revoked"])
    client.close()
    expect(client.state).toBe("revoked")

    // A later connect with the stored credential fails the same way, at once.
    await new Promise(r => setTimeout(r, 150))
    const again = countingWebSocket()
    const client2 = connect(credential, { WebSocket: again.WebSocket, ...FAST })
    clients.push(client2)
    await expect(client2.ready()).rejects.toMatchObject({ code: "revoked" })
    await new Promise(r => setTimeout(r, 600))
    expect(client2.state).toBe("revoked")
    expect(again.sockets.length).toBeLessThanOrEqual(2)
  }, 30_000)

  it("an unreachable daemon is offline (retried with backoff), and requests time out", async () => {
    const { client, d, credential } = await pairedClient()
    client.close()
    expect(client.state).toBe("closed")
    await expect(client.fetch("/x")).rejects.toMatchObject({ code: "closed" })
    await d.registry.shutdown()

    const { WebSocket, sockets } = countingWebSocket()
    const c = connect(credential, { WebSocket, ...FAST, handshakeTimeoutMs: 200, requestWaitMs: 1_500 })
    clients.push(c)
    await vi.waitFor(() => expect(c.state).toBe("offline"), { timeout: 5_000 })
    const err = await c.fetch("/x").catch((e: unknown) => e)
    expect((err as TunnelClientError).code).toBe("offline")
    expect(c.lastError?.code).toBe("offline")
    expect(sockets.length).toBeGreaterThan(2) // it keeps retrying (not revoked)
    c.close()
    const n = sockets.length
    await new Promise(r => setTimeout(r, 400))
    expect(sockets.length).toBeLessThanOrEqual(n + 1)
  }, 30_000)
})
