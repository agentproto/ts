import { describe, it, expect } from "vitest"
import {
  startTunnelHandshake,
  respondToTunnelHandshake,
  encodeTunnelMessage,
  decodeTunnelOffer,
  decodeTunnelAccept,
  TunnelHandshakeError,
  TUNNEL_E2E_VERSION,
  type TunnelHandshakeErrorCode,
} from "../tunnel-handshake.js"

const TOKEN = "apt_shared_tunnel_secret_abc123"

const eq = (a: Uint8Array, b: Uint8Array): boolean =>
  Buffer.from(a).equals(Buffer.from(b))

/** Assert `fn` throws a `TunnelHandshakeError` with exactly `code`. */
function expectError(fn: () => unknown, code: TunnelHandshakeErrorCode): void {
  let thrown: unknown
  try {
    fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(TunnelHandshakeError)
  if (thrown instanceof TunnelHandshakeError) expect(thrown.code).toBe(code)
}

/** Run a full handshake with a token on each side, returning both sessions. */
function run(daemonToken: string, hostToken: string) {
  const started = startTunnelHandshake(daemonToken)
  const { accept, session: host } = respondToTunnelHandshake(started.offer, hostToken)
  const daemon = started.complete(accept)
  return { started, accept, daemon, host }
}

describe("tunnel-e2e handshake — happy path", () => {
  it("derives crossed, matching direction keys when both sides share the token", () => {
    const { daemon, host } = run(TOKEN, TOKEN)

    // 32-byte AES-256 keys.
    expect(daemon.sendKey.length).toBe(32)
    expect(daemon.recvKey.length).toBe(32)

    // Role-crossed: daemon send == host recv, daemon recv == host send.
    expect(eq(daemon.sendKey, host.recvKey)).toBe(true)
    expect(eq(daemon.recvKey, host.sendKey)).toBe(true)

    // The two directions use distinct keys (never the same key both ways).
    expect(eq(daemon.sendKey, daemon.recvKey)).toBe(false)

    // Both sides bind to the identical transcript.
    expect(eq(daemon.transcriptHash, host.transcriptHash)).toBe(true)
  })

  it("produces fresh ephemeral keys per handshake (forward secrecy)", () => {
    const a = run(TOKEN, TOKEN)
    const b = run(TOKEN, TOKEN)
    // Same token, but independent ephemerals ⇒ different session keys.
    expect(eq(a.daemon.sendKey, b.daemon.sendKey)).toBe(false)
    expect(a.started.offer.ePub).not.toBe(b.started.offer.ePub)
  })

  it("round-trips offer + accept through encode/decode and still crosses keys", () => {
    const started = startTunnelHandshake(TOKEN)
    const offer = decodeTunnelOffer(encodeTunnelMessage(started.offer))
    expect(offer).toEqual(started.offer)

    const { accept, session: host } = respondToTunnelHandshake(offer, TOKEN)
    const decodedAccept = decodeTunnelAccept(encodeTunnelMessage(accept))
    expect(decodedAccept).toEqual(accept)

    const daemon = started.complete(decodedAccept)
    expect(eq(daemon.sendKey, host.recvKey)).toBe(true)
    expect(eq(daemon.recvKey, host.sendKey)).toBe(true)
  })
})

describe("tunnel-e2e handshake — token mismatch fails closed at handshake", () => {
  it("rejects the offer on the host side when tokens differ (bad_auth)", () => {
    const started = startTunnelHandshake(TOKEN)
    expectError(() => respondToTunnelHandshake(started.offer, "apt_WRONG_token"), "bad_auth")
  })

  it("rejects on the daemon side when the host answered under a different token (bad_auth)", () => {
    // Model a host that holds the WRONG token: it produces a well-formed accept
    // whose MAC is computed under its (wrong) token. Splice that accept's ePub +
    // mac onto the daemon's real offer context and hand it to the daemon — the
    // daemon (right token) must reject it before deriving/using any key.
    const daemon = startTunnelHandshake(TOKEN)
    const wrongHost = respondToTunnelHandshake(
      startTunnelHandshake("apt_WRONG_token").offer,
      "apt_WRONG_token",
    )
    expectError(() => daemon.complete(wrongHost.accept), "bad_auth")
  })
})

describe("tunnel-e2e handshake — tamper detection", () => {
  it("rejects a tampered offer ephemeral (bad_auth — MAC no longer covers it)", () => {
    const started = startTunnelHandshake(TOKEN)
    // Flip the daemon ephemeral but keep the original MAC.
    const other = startTunnelHandshake(TOKEN)
    const tampered = { ...started.offer, ePub: other.offer.ePub }
    expectError(() => respondToTunnelHandshake(tampered, TOKEN), "bad_auth")
  })

  it("rejects a tampered accept ephemeral (bad_auth)", () => {
    const started = startTunnelHandshake(TOKEN)
    const { accept } = respondToTunnelHandshake(started.offer, TOKEN)
    const other = startTunnelHandshake(TOKEN)
    const tampered = { ...accept, ePub: other.offer.ePub }
    expectError(() => started.complete(tampered), "bad_auth")
  })

  it("rejects a corrupted MAC on the offer", () => {
    const started = startTunnelHandshake(TOKEN)
    const macBuf = Buffer.from(started.offer.mac, "base64")
    macBuf.writeUInt8(macBuf.readUInt8(0) ^ 0xff, 0)
    const tampered = { ...started.offer, mac: macBuf.toString("base64") }
    expectError(() => respondToTunnelHandshake(tampered, TOKEN), "bad_auth")
  })
})

describe("tunnel-e2e handshake — malformed + version guards", () => {
  it("rejects an unknown offer version", () => {
    const started = startTunnelHandshake(TOKEN)
    const bad = { ...started.offer, v: 999 } as unknown as typeof started.offer
    expectError(() => respondToTunnelHandshake(bad, TOKEN), "unsupported_version")
  })

  it("rejects an unknown accept version on complete", () => {
    const started = startTunnelHandshake(TOKEN)
    const { accept } = respondToTunnelHandshake(started.offer, TOKEN)
    const bad = { ...accept, v: 42 } as unknown as typeof accept
    expectError(() => started.complete(bad), "unsupported_version")
  })

  it("rejects a truncated offer on decode", () => {
    expectError(() => decodeTunnelOffer(new TextEncoder().encode("{not json")), "malformed_offer")
  })

  it("rejects an offer missing fields on decode", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: TUNNEL_E2E_VERSION, ePub: "x" }))
    expectError(() => decodeTunnelOffer(bytes), "malformed_offer")
  })

  it("rejects an accept missing fields on decode", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: TUNNEL_E2E_VERSION, mac: "x" }))
    expectError(() => decodeTunnelAccept(bytes), "malformed_accept")
  })

  it("fails closed on a garbage ephemeral key (never derives a session)", () => {
    // A valid-base64 but non-SPKI ePub. The swapped ePub also breaks the MAC, so
    // this fails closed (bad_auth) before key parse — either way, no session.
    const started = startTunnelHandshake(TOKEN)
    const offer = { ...started.offer, ePub: Buffer.from([1, 2, 3, 4]).toString("base64") }
    let thrown: unknown
    try {
      respondToTunnelHandshake(offer, TOKEN)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(TunnelHandshakeError)
  })
})
