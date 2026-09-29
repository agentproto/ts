import type { Agent } from "node:http"
import WebSocket from "ws"
import { wrapWebSocket, type FrameSink } from "@agentproto/acp/tunnel"

export interface DialRendezvousOptions {
  /** A `ws`-compatible agent (e.g. an HTTPS proxy agent). `ws` ignores
   *  `HTTPS_PROXY` on its own, so a host behind a proxy passes one here. */
  agent?: Agent
}

/**
 * Dial a rendezvous broker outbound and adapt the socket to a `FrameSink`.
 * The default `PairingRegistryDeps.dial`. Rejects if the dial fails; honours
 * `signal` so a registry shutdown tears down an in-flight dial promptly.
 */
export async function dialRendezvous(
  url: string,
  signal: AbortSignal,
  opts: DialRendezvousOptions = {},
): Promise<FrameSink> {
  const ws = new WebSocket(url, opts.agent ? { agent: opts.agent } : undefined)
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      ws.off("open", onOpen)
      ws.off("error", onError)
      signal.removeEventListener("abort", onAbort)
    }
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    const onAbort = (): void => {
      cleanup()
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      reject(new Error("dial aborted"))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    ws.once("open", onOpen)
    ws.once("error", onError)
    signal.addEventListener("abort", onAbort)
  })
  return wrapWebSocket(ws as unknown as Parameters<typeof wrapWebSocket>[0])
}
