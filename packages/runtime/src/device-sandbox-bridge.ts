/**
 * Local loopback HTTP bridge for the `device` sandbox provider
 * (DEVICES-PLAN PR-D). `createSandboxAgentSessionHost` /
 * `sandbox-agent-session-proxy.ts` only need a `mcpUrl` they can plain
 * `fetch()`/MCP-connect to — they have no idea (and don't need one) that
 * the box behind it is actually another paired daemon reached over the
 * pair/v2 tunnel rather than a local process or a cloud VM.
 *
 * `startDeviceSandboxBridge` starts a tiny `node:http` server on
 * `127.0.0.1:<free port>` whose handler forwards every incoming request
 * (method, path, headers, body) to the target device via
 * `HostRegistry.forwardHttpStream` — prefixing the path with
 * `/device-spawn` so it lands on the target's own gated
 * `handleDeviceSpawn` route (http-server.ts) — and relays the streamed
 * response straight back. `forwardHttpStream` dials fresh per call (no
 * standing connection), so this bridge is a pure per-request relay: there
 * is nothing to reconnect or keep warm between requests.
 *
 * `close()` only tears down THIS local relay server — it must never touch
 * the remote device's own daemon process (we don't own it; the remote
 * session keeps running there independently of our bridge).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createProbeServer } from "node:net"
import { Readable } from "node:stream"
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web"
import type { HostRegistry } from "./host-registry.js"

export interface DeviceSandboxBridgeOpts {
  hostRegistry: HostRegistry
  /** Fingerprint or name of the registered host to forward to
   *  (`HostRegistry.forwardHttpStream`'s `idOrName`). */
  target: string
}

export interface DeviceSandboxBridge {
  /** This bridge's own loopback MCP URL — hand this straight to
   *  `BootedSandbox.mcpUrl`. */
  mcpUrl: string
  /** Close the local relay server. Never touches the remote device. */
  close(): Promise<void>
}

/** Headers stripped before relaying either direction — hop-by-hop framing
 *  that must be recomputed by each leg, not carried across it verbatim. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host"])

function collectHeaders(raw: IncomingMessage["headers"]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue
    headers[k] = Array.isArray(v) ? v.join(", ") : v
  }
  return headers
}

async function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  return new Uint8Array(Buffer.concat(chunks))
}

export async function startDeviceSandboxBridge(
  opts: DeviceSandboxBridgeOpts,
): Promise<DeviceSandboxBridge> {
  const { hostRegistry, target } = opts

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(err => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" })
      }
      res.end(
        JSON.stringify({
          error: "device_sandbox_bridge_failed",
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    let upstream: Awaited<ReturnType<HostRegistry["forwardHttpStream"]>>
    try {
      upstream = await hostRegistry.forwardHttpStream(target, {
        method: req.method ?? "GET",
        path: `/device-spawn${req.url ?? "/"}`,
        headers: collectHeaders(req.headers),
        ...(body ? { body } : {}),
      })
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: "device_unreachable",
          message: err instanceof Error ? err.message : String(err),
        }),
      )
      return
    }

    const resHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase() === "content-length") continue
      resHeaders[k] = v
    }
    res.writeHead(upstream.status, resHeaders)
    Readable.fromWeb(upstream.body as unknown as NodeWebReadableStream<Uint8Array>).pipe(res)
  }

  const port = await getFreePort()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve())
  })

  return {
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    async close(): Promise<void> {
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** Allocate an OS-assigned free TCP port on loopback (mirrors
 *  `sandbox-providers/local.ts`'s helper of the same shape). */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createProbeServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address()
      if (address === null || typeof address === "string") {
        srv.close(() => reject(new Error("failed to allocate a free port")))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}
