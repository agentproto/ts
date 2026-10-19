/**
 * In-process fake of the computer controller (`node:http`, no dependencies)
 * — a minimal mirror of the real controller's `src/api/app.ts` contract:
 * bearer auth + X-Tenant-Id, create/exec/status/suspend/resume/rm, with
 * knobs per test for failures and exec-script interception.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"

export interface FakeControllerOptions {
  token: string
  port?: number
  /** Throw/return these statuses on specific ops to test error mapping. */
  createStatus?: number
  createError?: string
  execStatus?: number
  statusNotFound?: boolean
  /** Simulate suspend: state stops being "running". */
  onSuspend?: () => void
  /** Ports the controller reports as published (create + GET). */
  publishedPorts?: Array<{ host: number; guest: number }>
  /** Model a controller without the attach/detach routes (404). */
  noSessionRoutes?: boolean
  /** Provide a custom exec outcome for this invocation */
  execOutcome?: (argv: string[], body: { timeoutSec: number }) => { exitCode: number; stdout: string; stderr: string } | undefined
}

/** Everything recorded, for assertions (no secrets captured in plain logs). */
export class FakeController {
  readonly server: Server
  readonly createBodies: Array<Record<string, unknown>> = []
  readonly execs: Array<{ id: string; argv: string[]; timeoutSec: number }> = []
  readonly suspended: string[] = []
  readonly resumed: string[] = []
  readonly removed: string[] = []
  readonly states = new Map<string, string>()
  /** Controller-held session refcount and per-computer cap. */
  readonly sessions = new Map<string, number>()
  readonly maxSessions = new Map<string, number>()
  readonly fileSystem = new Map<string, string>()
  private nextId = 1
  private nextStateSnapshot: string | undefined = undefined
  private lastCreateState = "running"

  constructor(public options: FakeControllerOptions) {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        res.statusCode = 500
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      })
    })
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as { port: number }).port}`
  }

  setState(id: string, state: string): void {
    this.states.set(id, state)
  }

  setNextCreateState(state: string): void {
    this.nextStateSnapshot = state
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve))
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`)
    const body = await readBody(req)

    // Auth: bearer + tenant header, exactly the real middleware's shape.
    const auth = req.headers.authorization ?? ""
    if (!/^Bearer /.test(auth) || auth.slice("Bearer ".length) !== this.options.token) {
      return reply(res, 401, { error: "unauthorized" })
    }
    if (req.headers["x-tenant-id"] !== "tenant-a") {
      return reply(res, 403, { error: "missing X-Tenant-Id header" })
    }

    if (url.pathname === "/v1/computers" && req.method === "POST") {
      if (this.options.createStatus) {
        return reply(res, this.options.createStatus, { error: this.options.createError ?? "failed" })
      }
      const parsed = JSON.parse(body) as Record<string, unknown>
      this.createBodies.push(parsed)
      const id = `cmp-${(this.nextId++).toString().padStart(3, "0")}`
      const state = this.nextStateSnapshot ?? this.lastCreateState
      this.nextStateSnapshot = undefined
      this.states.set(id, state)
      this.maxSessions.set(id, typeof parsed.maxSessions === "number" ? parsed.maxSessions : 1)
      return reply(res, 201, { id, template: parsed.template, state, ports: this.options.publishedPorts ?? [] })
    }

    const computerMatch = /^\/v1\/computers\/([^/]+)/.exec(url.pathname)
    if (!computerMatch) return reply(res, 404, { error: "not found" })
    const id = decodeURIComponent(computerMatch[1] as string)

    if (req.method === "GET" && url.pathname === `/v1/computers/${productIdPath(computerMatch[1] as string)}`) {
      if (this.options.statusNotFound || !this.states.has(id)) return reply(res, 404, { error: "not found" })
      return reply(res, 200, { name: id, state: this.states.get(id), ports: this.options.publishedPorts ?? [], egress: [], pinsStale: false, pinsTtlSec: 21600 })
    }
    if (url.pathname.endsWith("/attach") && req.method === "POST" && !this.options.noSessionRoutes) {
      const held = this.sessions.get(id) ?? 0
      const max = this.maxSessions.get(id) ?? 1
      if (held >= max) return reply(res, 409, { error: "session limit reached", sessions: held, maxSessions: max })
      this.sessions.set(id, held + 1)
      return reply(res, 200, { sessions: held + 1, maxSessions: max })
    }
    if (url.pathname.endsWith("/detach") && req.method === "POST" && !this.options.noSessionRoutes) {
      const held = Math.max((this.sessions.get(id) ?? 0) - 1, 0)
      this.sessions.set(id, held)
      return reply(res, 200, { sessions: held, maxSessions: this.maxSessions.get(id) ?? 1 })
    }
    if (req.method === "DELETE") {
      const attached = this.sessions.get(id) ?? 0
      if (attached > 0 && url.searchParams.get("force") !== "true") {
        return reply(res, 409, { error: "computer has attached sessions", sessions: attached })
      }
      this.removed.push(id)
      this.states.delete(id)
      return reply(res, 200, { ok: true })
    }
    if (url.pathname.endsWith("/exec") && req.method === "POST") {
      if (this.options.execStatus) return reply(res, this.options.execStatus, { error: "exec failed" })
      const parsed = JSON.parse(body) as { argv: string[]; timeoutSec: number }
      this.execs.push({ id, argv: parsed.argv, timeoutSec: parsed.timeoutSec })
      if (this.states.get(id) !== "running") return reply(res, 409, { error: "sandbox not running", state: this.states.get(id) })
      return reply(res, 200, this.runExec(id, parsed.argv, parsed))
    }
    if (url.pathname.endsWith("/suspend")) {
      this.suspended.push(id)
      this.states.set(id, "stopped")
      this.options.onSuspend?.()
      return reply(res, 200, { ok: true, snapshot: `snap-${id}-0`, state: "stopped" })
    }
    if (url.pathname.endsWith("/resume")) {
      this.resumed.push(id)
      if (!this.states.has(id)) return reply(res, 404, { error: "not found" })
      // Restore into a NEW computer: the real controller's behaviour.
      const newId = `cmp-restored-${(this.nextId++).toString().padStart(3, "0")}`
      this.states.set(newId, "running")
      this.states.delete(id)
      return reply(res, 201, { ok: true, id: newId, state: "running" })
    }
    if (url.pathname.endsWith("/fork")) return reply(res, 201, { id: `cmp-fork-${this.nextId++}`, tenantId: "tenant-a" })
    return reply(res, 404, { error: "not found" })
  }

  /** Tiny in-box shell simulation so health probes / file IO flows work. */
  private runExec(id: string, argv: string[], parsed: { timeoutSec: number }): { exitCode: number; stdout: string; stderr: string } {
    const custom = this.options.execOutcome?.(argv, parsed)
    if (custom) return custom
    const script = argv[2] ?? ""
    if (script.includes("http://127.0.0.1") && !script.includes("agentproto serve")) {
      // Health probes: the daemon is considered DOWN until a serve command
      // ran (unless serveFixesHealth=false models a daemon that never comes
      // up — used by the reclaim test).
      const healthy = this.serveSeen && this.serveFixesHealth
      if (script.includes("done; exit 1")) {
        return { exitCode: healthy ? 0 : 1, stdout: "", stderr: "" }
      }
      return { exitCode: 0, stdout: healthy ? "ok" : "__down__", stderr: "" }
    }
    if (script.startsWith("test -f ") || script.startsWith("test -e ")) {
      const path = `"${script.replace(/'/g, "")}"` // unused; extract from quotes
      const match = /'([^']*)'/.exec(script)
      const target = match?.[1] ?? path
      return this.fileSystem.has(target) ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 65, stdout: "", stderr: "" }
    }
    if (script.includes("dd if=")) {
      const match = /dd if='([^']*)'/.exec(script)
      const content = match ? (this.fileSystem.get(match[1] as string) ?? "") : ""
      const skipMatch = /skip=(\d+)/.exec(script)
      const block = Number(skipMatch?.[1] ?? 0)
      const offset = block * 700_000
      if (script.includes("| wc -c")) {
        return { exitCode: 0, stdout: String(Math.max(0, content.length - offset)), stderr: "" }
      }
      const piece = content.slice(offset, offset + 700_000)
      return { exitCode: 0, stdout: Buffer.from(piece, "utf8").toString("base64") + "\n", stderr: "" }
    }
    if (script.includes("base64 -d >> ")) {
      const match = />> '([^']*)'/.exec(script)
      const chunkMatch = /^printf %s '([^']*)'/.exec(script)
      const b64 = chunkMatch?.[1] ?? ""
      if (script.includes(": > ")) {
        const zeroMatch = /: > '([^']*)'/.exec(script)
        if (zeroMatch) this.fileSystem.set(zeroMatch[1] as string, "")
      }
      if (match) {
        this.fileSystem.set(match[1] as string, (this.fileSystem.get(match[1] as string) ?? "") + Buffer.from(b64, "base64").toString("utf8"))
      }
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    if (script.startsWith("cat ") && script.includes(".agentproto-daemon.origin")) {
      return this.daemonOrigin ? { exitCode: 0, stdout: this.daemonOrigin, stderr: "" } : { exitCode: 1, stdout: "", stderr: "" }
    }
    if (script.includes("pkill -f")) {
      this.serveSeen = false
      this.killCount++
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    if (script.startsWith("mkdir -p") || script.startsWith(": > ") || script.includes("echo started")) {
      if (script.includes("agentproto serve")) {
        this.serveSeen = true
        this.serveCount++
        const origin = /--allow-origin '([^']*)'/.exec(script)
        this.daemonOrigin = origin?.[1]
      }
      return { exitCode: 0, stdout: "started", stderr: "" }
    }
    if (script.includes("agentproto --version")) {
      return this.cliBaked
        ? { exitCode: 0, stdout: `agentproto ${this.bakedCliVersion} (d7c36672)\n`, stderr: "" }
        : { exitCode: 127, stdout: "", stderr: "agentproto: command not found" }
    }
    if (script.includes("npm i -g")) return { exitCode: 0, stdout: "", stderr: "" }
    // plain scripts (setupCommands, callers) echo their script hash — tests
    // shouldn't depend on real output
    return { exitCode: 0, stdout: `ran:${script.length}`, stderr: "" }
  }

  /** Models an image with the agentproto CLI already installed. */
  cliBaked = false
  bakedCliVersion = "1.26.0"
  daemonDown = false
  /** The --allow-origin recorded by the last serve command (the marker file). */
  daemonOrigin: string | undefined = undefined
  serveCount = 0
  killCount = 0
  /** Set once a serve command ran (models the box's own daemon state). */
  serveSeen = false
  /** Models a daemon that refuses to become healthy even after launch. */
  serveFixesHealth = true
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ""
    req.on("data", (c: Buffer) => (data += c.toString()))
    req.on("end", () => resolve(data))
  })
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

/** path segment urlencoded-safe passthrough (fake ids are safe tokens) */
function productIdPath(segment: string): string {
  return segment
}
