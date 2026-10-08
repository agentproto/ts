/**
 * Public callback base for the receiver.
 *
 * The daemon only POSTs to public https URLs (SSRF guard), so the receiver
 * needs one. Either the operator supplies `EVENTS_CALLBACK_BASE` (a named
 * tunnel or reverse proxy), or we start a cloudflared quick tunnel.
 *
 * Two traps this handles: a global `~/.cloudflared/config.yml` ending in a
 * catch-all `http_status:404` hijacks quick tunnels (hence the empty
 * `--config`), and the edge needs 1-2 minutes before a new hostname routes
 * (hence the probe loop).
 */

import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface PublicBase {
  /** Resolves to the https origin once it actually routes to the receiver. */
  base: Promise<string>
  stop(): void
}

export function staticPublicBase(base: string): PublicBase {
  return { base: Promise.resolve(base.replace(/\/$/, "")), stop() {} }
}

export function startQuickTunnel(opts: {
  localPort: number
  /** Path the receiver serves; probed until the receiver itself answers 401 to an unsigned POST. */
  probePath: string
  log?: (line: string) => void
}): PublicBase {
  const config = join(mkdtempSync(join(tmpdir(), "events-channel-")), "cf-empty.yml")
  writeFileSync(config, "")
  const child: ChildProcess = spawn(
    "cloudflared",
    ["tunnel", "--config", config, "--no-autoupdate", "--url", `http://127.0.0.1:${opts.localPort}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
  const base = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cloudflared did not report a tunnel URL")), 60_000)
    const onData = (chunk: Buffer) => {
      const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (!match) return
      clearTimeout(timer)
      child.stdout?.off("data", onData)
      child.stderr?.off("data", onData)
      void waitUntilRouted(match[0], opts.probePath).then(() => {
        opts.log?.(`tunnel ${match[0]}`)
        resolve(match[0])
      }, reject)
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.once("error", error => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return { base, stop: () => void child.kill("SIGTERM") }
}

async function waitUntilRouted(origin: string, probePath: string): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      // The receiver answers an unsigned POST with 401; an edge that does not route yet answers 404/530.
      if ((await fetch(`${origin}${probePath}`, { method: "POST", body: "{}" })).status === 401) return
    } catch {
      // DNS or connect failure: not routable yet.
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error(`tunnel ${origin} never routed to the receiver`)
}
