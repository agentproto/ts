/**
 * The pairing path hands the daemon's gateway a request whose `Host` is
 * 127.0.0.1 and which carries no X-Forwarded-*: the daemon cannot tell it was
 * reached at `https://<fp>.agentproto.cloud/d/<fp>/...`. So
 * `buildDaemonTunnelServerOptions` injects a daemon-signed public base header.
 * A real tunnel server forwards a frame to a small echo gateway; the headers the
 * gateway receives are then fed to the runtime's resolver.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import {
  createTunnelServer,
  decodeData,
  type FrameSink,
  type TunnelFrame,
} from "@agentproto/acp/tunnel"
import {
  PUBLIC_BASE_HEADER,
  resolvePublicBase,
  signPublicBase,
  type GatewayHandle,
} from "@agentproto/runtime"
import { buildDaemonTunnelServerOptions, pairingPublicBase } from "../tunnel-serve.js"

const FP = "0123456789abcdef0123456789abcdef"
const PAIRING_BASE = `https://${FP}.agentproto.cloud/d/${FP}`

function memorySink(): { sink: FrameSink; sent: TunnelFrame[]; push: (f: TunnelFrame) => void } {
  const sent: TunnelFrame[] = []
  let onFrame: ((f: TunnelFrame) => void) | undefined
  const sink: FrameSink = {
    send: frame => {
      sent.push(frame)
    },
    close: () => {},
    onFrame: handler => {
      onFrame = handler
      return () => {}
    },
    onClose: () => () => {},
    get isOpen() {
      return true
    },
  }
  return { sink, sent, push: f => onFrame?.(f) }
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error("timed out waiting for a tunnel response")
    await new Promise(r => setTimeout(r, 10))
  }
}

describe("buildDaemonTunnelServerOptions: public base on the pairing path", () => {
  let gatewayServer: Server | undefined
  let gatewayUrl = ""

  beforeEach(async () => {
    gatewayServer = createServer((req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(req.headers))
    })
    await new Promise<void>(r => gatewayServer!.listen(0, "127.0.0.1", r))
    gatewayUrl = `http://127.0.0.1:${(gatewayServer.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>(r => gatewayServer?.close(() => r()))
    gatewayServer = undefined
  })

  /** Forward one GET through the tunnel and return the headers the gateway saw. */
  async function gatewaySees(
    input: { publicBase?: string },
    frameHeaders: Record<string, string> = {},
  ): Promise<IncomingHttpHeaders> {
    const { sink, sent, push } = memorySink()
    const gateway = { url: gatewayUrl, token: "unused" } as unknown as GatewayHandle
    const server = createTunnelServer({
      sink,
      ...buildDaemonTunnelServerOptions({ gateway, label: "test", spawnPty: null, ...input }),
    })
    try {
      push({
        t: "http_request",
        reqId: "r1",
        method: "GET",
        path: "/apps/x/ui",
        headers: { "accept-encoding": "identity", ...frameHeaders },
      })
      const res = await waitFor(() =>
        sent.find((f): f is Extract<TunnelFrame, { t: "http_response" }> => f.t === "http_response"),
      )
      expect(res.status).toBe(200)
      return JSON.parse(decodeData(res.body ?? "").toString("utf8")) as IncomingHttpHeaders
    } finally {
      await server.close()
    }
  }

  it("makes the gateway resolve the /d/<id> public base, not 127.0.0.1", async () => {
    const seen = await gatewaySees({ publicBase: PAIRING_BASE })
    expect(seen["x-forwarded-host"]).toBeUndefined()
    expect(seen.host).toMatch(/^127\.0\.0\.1:/)
    expect(resolvePublicBase(seen, "")).toMatchObject({
      baseUrl: PAIRING_BASE,
      pathPrefix: `/d/${FP}`,
      source: "trusted-header",
    })
  })

  it("overrides a public base header the far end put in its own frame", async () => {
    const seen = await gatewaySees(
      { publicBase: PAIRING_BASE },
      { [PUBLIC_BASE_HEADER]: signPublicBase("https://evil.example.test/d/x") },
    )
    expect(resolvePublicBase(seen, "").baseUrl).toBe(PAIRING_BASE)
  })

  it("does not trust a forged header when the daemon has no base to inject", async () => {
    const seen = await gatewaySees({}, { [PUBLIC_BASE_HEADER]: "https://evil.example.test/d/x" })
    expect(resolvePublicBase(seen, "").baseUrl).toBe(`http://${seen.host}`)
  })
})

describe("pairingPublicBase", () => {
  it("is the pair page origin plus the service-worker scope /d/<fp>", () => {
    expect(pairingPublicBase("https://{fp}.agentproto.cloud/pair", FP)).toBe(PAIRING_BASE)
  })

  it("follows a self-hosted pair page, port included, and a plain shared origin", () => {
    expect(pairingPublicBase("https://{fp}.pair.example.test:8443/pair", FP)).toBe(
      `https://${FP}.pair.example.test:8443/d/${FP}`,
    )
    expect(pairingPublicBase("https://pair.example.test/pair", FP)).toBe(`https://pair.example.test/d/${FP}`)
  })

  it("is undefined for a page setting that does not resolve", () => {
    expect(pairingPublicBase("not a url", FP)).toBeUndefined()
    expect(pairingPublicBase("https://x.test/{fp}", FP)).toBeUndefined()
  })
})
