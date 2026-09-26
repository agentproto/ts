/**
 * One-turn test session for `agentproto setup`'s first-run step: spawn the
 * harness on the daemon, open its output stream, send one prompt, relay the
 * text lines until the turn ends, then stop the session. Same routes and
 * line classification as `agentproto chat` (`/sessions/agent`,
 * `/sessions/:id/stream`, `/sessions/:id/prompt`, `/sessions/:id/kill`).
 */

import http from "node:http"
import https from "node:https"
import type { SessionDescriptor } from "@agentproto/runtime"
import { discoverDaemon, httpPostJson } from "../commands/_daemon-helpers.js"
import { classifyChatLine } from "../commands/chat.js"
import type { FirstRunResult } from "./types.js"

const TURN_TIMEOUT_MS = 120_000

export async function runFirstSession(
  slug: string,
  prompt: string,
  onLine: (line: string) => void,
  opts: { cwd: string; timeoutMs?: number } = { cwd: process.cwd() },
): Promise<FirstRunResult> {
  const report = await discoverDaemon()
  if (!report.found) return { ok: false, error: "no running daemon found" }
  const endpoint = report.found

  let desc: SessionDescriptor
  try {
    desc = await httpPostJson<SessionDescriptor>(
      `${endpoint.url}/sessions/agent`,
      { adapter: slug, cwd: opts.cwd, label: "setup test", origin: "cli" },
      endpoint.token,
    )
  } catch (err) {
    return { ok: false, error: `spawn failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const kill = () =>
    httpPostJson(`${endpoint.url}/sessions/${encodeURIComponent(desc.id)}/kill`, {}, endpoint.token).catch(() => undefined)

  const result = await new Promise<FirstRunResult>((resolve) => {
    let done = false
    let sawText = false
    const finish = (r: FirstRunResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      req.destroy()
      resolve(r)
    }
    const timer = setTimeout(
      () => finish({ ok: false, error: `no turn end within ${Math.round((opts.timeoutMs ?? TURN_TIMEOUT_MS) / 1000)}s` }),
      opts.timeoutMs ?? TURN_TIMEOUT_MS,
    )
    const url = new URL(`${endpoint.url}/sessions/${desc.id}/stream`)
    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (endpoint.token) headers.authorization = `Bearer ${endpoint.token}`
    const req = (url.protocol === "https:" ? https : http).get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        finish({ ok: false, error: `stream HTTP ${res.statusCode}` })
        return
      }
      let buf = ""
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => {
        buf += chunk
        let idx = buf.indexOf("\n\n")
        while (idx !== -1) {
          const event = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const evLine of event.split("\n")) {
            if (!evLine.startsWith("data:")) continue
            let line: unknown
            try {
              line = Reflect.get(JSON.parse(evLine.slice(5).trim()) ?? {}, "line")
            } catch {
              continue // heartbeat / ill-formed frame
            }
            if (typeof line !== "string") continue
            const { plain, turnBoundary, suppress } = classifyChatLine(line)
            if (!suppress && plain.trim() !== "") {
              sawText = true
              onLine(plain)
            }
            if (turnBoundary) finish(sawText ? { ok: true } : { ok: false, error: "the turn ended without output" })
          }
          idx = buf.indexOf("\n\n")
        }
      })
      res.on("end", () => finish({ ok: false, error: "the session ended before its turn finished" }))
      // Stream is open: send the prompt now so no early line is missed.
      httpPostJson(`${endpoint.url}/sessions/${desc.id}/prompt`, { prompt }, endpoint.token).catch((err: unknown) =>
        finish({ ok: false, error: `prompt failed: ${err instanceof Error ? err.message : String(err)}` }),
      )
    })
    req.on("error", (err) => finish({ ok: false, error: `stream error: ${err.message}` }))
  })

  await kill()
  return result
}
