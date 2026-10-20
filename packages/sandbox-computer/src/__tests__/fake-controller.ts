/**
 * In-process fake of the computer controller (`node:http`, no dependencies)
 * — a minimal mirror of the real controller's `src/api/app.ts` contract:
 * bearer auth + X-Tenant-Id, create/exec/status/suspend/resume/rm, with
 * knobs per test for failures and exec-script interception.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import {
  attachRequestSchema,
  computerStatusSchema,
  createComputerRequestSchema,
  createComputerResponseSchema,
  errorResponseSchema,
  execRequestSchema,
  execResponseSchema,
  resumeResponseSchema,
  sessionsResponseSchema,
  suspendResponseSchema,
} from "@agentproto/computer-api"

/** Contract guard: the fake must emit controller-shaped bodies (the
 *  package's `contract.test.ts` pins those same schemas with fixtures). A
 *  failure here means the fake has drifted from the published contract,
 *  exactly what the schema gate exists for. */
function assertContract(
  schema: { parse: (v: unknown) => unknown },
  value: unknown,
): void {
  schema.parse(value)
}

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
  /** Model a controller whose GET omits `ports` (only create reports them). */
  getOmitsPorts?: boolean
  /** Edge emulation: every request must carry these headers (lowercase name → value) or it is refused with 403 before auth. */
  requireHeaders?: Record<string, string>
  /** Model a controller without the attach/detach routes (404). */
  noSessionRoutes?: boolean
  /** Make detach answer this status instead of releasing the slot. */
  detachStatus?: number
  /** Provide a custom exec outcome for this invocation */
  execOutcome?: (argv: string[], body: { timeoutSec: number }) => { exitCode: number; stdout: string; stderr: string } | undefined
  /** `egressIp` reported on create and GET. Omitted from responses when undefined. */
  egressIp?: { id: string; publicIp: string } | null
  /** Extra top-level fields on a create error body (e.g. host-capacity details). */
  createErrorExtra?: Record<string, unknown>
  /** `Retry-After` header sent with a create error. */
  createRetryAfter?: string
}

/** Everything recorded, for assertions (no secrets captured in plain logs). */
export class FakeController {
  readonly server: Server
  readonly requestHeaders: Array<Record<string, string | string[] | undefined>> = []
  readonly createBodies: Array<Record<string, unknown>> = []
  readonly execs: Array<{ id: string; argv: string[]; timeoutSec: number }> = []
  readonly suspended: string[] = []
  readonly resumed: string[] = []
  readonly removed: string[] = []
  /** Bodies of the attach/detach calls, for holder assertions. `holder` is
   *  undefined for a body-less legacy call. */
  readonly attachBodies: Array<{ id: string; holder?: string }> = []
  readonly detachBodies: Array<{ id: string; holder?: string }> = []
  readonly daemonProxyRequests: Array<{
    id: string
    path: string
    method: string
    headers: Record<string, string | string[] | undefined>
  }> = []
  readonly states = new Map<string, string>()
  /** Controller-held session refcount and per-computer cap. */
  readonly sessions = new Map<string, number>()
  readonly maxSessions = new Map<string, number>()
  /** Holders currently occupying a session slot, per computer. */
  readonly sessionHolders = new Map<string, Set<string>>()
  readonly fileSystem = new Map<string, string>()
  // Process-wide so ids never repeat across instances: the provider keeps
  // per-id bookkeeping at module level.
  private static idCounter = 1
  private get nextId(): number {
    return FakeController.idCounter
  }
  private set nextId(value: number) {
    FakeController.idCounter = value
  }
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

  /** Holders occupying a slot on this computer, created on first use. */
  private holders(id: string): Set<string> {
    let holders = this.sessionHolders.get(id)
    if (!holders) {
      holders = new Set()
      this.sessionHolders.set(id, holders)
    }
    return holders
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`)
    const body = await readBody(req)
    this.requestHeaders.push(req.headers)
    for (const [name, value] of Object.entries(this.options.requireHeaders ?? {})) {
      if (req.headers[name] !== value) return reply(res, 403, { error: "edge refused" })
    }

    // Daemon-proxy route: mirrors the real controller's
    // `/v1/computers/:id/daemon/*` — gated by `X-Controller-Authorization` +
    // `X-Tenant-Id`, NOT the regular `Authorization` bearer (which belongs
    // to the box's own daemon and passes through untouched). Bypasses the
    // generic auth check below entirely, same as the real route.
    const daemonMatch = /^\/v1\/computers\/([^/]+)\/daemon(\/.*)?$/.exec(url.pathname)
    if (daemonMatch) {
      const id = decodeURIComponent(daemonMatch[1] as string)
      const ctrlAuth = req.headers["x-controller-authorization"]
      if (ctrlAuth !== `Bearer ${this.options.token}`) return reply(res, 401, { error: "unauthorized" })
      if (req.headers["x-tenant-id"] !== "tenant-a") {
        return reply(res, 403, { error: "missing X-Tenant-Id header" })
      }
      const daemonPath = (daemonMatch[2] ?? "/") + url.search
      this.daemonProxyRequests.push({
        id,
        path: daemonPath,
        method: req.method ?? "GET",
        headers: { ...req.headers },
      })
      return reply(res, 200, {
        echoPath: daemonPath,
        echoMethod: req.method ?? "GET",
        sawAuthorization: req.headers.authorization ?? null,
      })
    }

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
        const body = { error: this.options.createError ?? "failed", ...this.options.createErrorExtra }
        assertContract(errorResponseSchema, body)
        if (this.options.createRetryAfter !== undefined) res.setHeader("Retry-After", this.options.createRetryAfter)
        return reply(res, this.options.createStatus, body)
      }
      const parsed = JSON.parse(body) as Record<string, unknown>
      assertContract(createComputerRequestSchema, parsed)
      this.createBodies.push(parsed)
      const id = `cmp-${(this.nextId++).toString().padStart(3, "0")}`
      const state = this.nextStateSnapshot ?? this.lastCreateState
      this.nextStateSnapshot = undefined
      this.states.set(id, state)
      this.maxSessions.set(id, typeof parsed.maxSessions === "number" ? parsed.maxSessions : 1)
      const responseBody = {
        id,
        template: parsed.template,
        state,
        ports: this.options.publishedPorts ?? [],
        ...(this.options.egressIp !== undefined ? { egressIp: this.options.egressIp } : {}),
      }
      assertContract(createComputerResponseSchema, responseBody)
      return reply(res, 201, responseBody)
    }

    const computerMatch = /^\/v1\/computers\/([^/]+)/.exec(url.pathname)
    if (!computerMatch) return reply(res, 404, { error: "not found" })
    const id = decodeURIComponent(computerMatch[1] as string)

    if (req.method === "GET" && url.pathname === `/v1/computers/${productIdPath(computerMatch[1] as string)}`) {
      if (this.options.statusNotFound || !this.states.has(id)) return reply(res, 404, { error: "not found" })
      const responseBody = {
        name: id,
        state: this.states.get(id),
        ...(this.options.getOmitsPorts ? {} : { ports: this.options.publishedPorts ?? [] }),
        ...(this.options.egressIp !== undefined ? { egressIp: this.options.egressIp } : {}),
        egress: [],
        pinsStale: false,
        pinsTtlSec: 21600,
      }
      assertContract(computerStatusSchema, responseBody)
      return reply(res, 200, responseBody)
    }
    if (url.pathname.endsWith("/attach") && req.method === "POST" && !this.options.noSessionRoutes) {
      const parsed = parseSessionBody(body)
      if (!parsed.ok) return reply(res, parsed.status, { error: parsed.error })
      this.attachBodies.push({ id, holder: parsed.body.holder })
      const held = this.sessions.get(id) ?? 0
      const max = this.maxSessions.get(id) ?? 1
      const holders = this.holders(id)
      if (parsed.body.holder !== undefined) {
        if (holders.has(parsed.body.holder)) {
          const attachBody = { sessions: held, maxSessions: max }
          assertContract(sessionsResponseSchema, attachBody)
          return reply(res, 200, attachBody)
        }
        if (held >= max) return reply(res, 409, { error: "session limit reached", sessions: held, maxSessions: max })
        holders.add(parsed.body.holder)
      } else if (held >= max) {
        return reply(res, 409, { error: "session limit reached", sessions: held, maxSessions: max })
      }
      this.sessions.set(id, held + 1)
      const attachBody = { sessions: held + 1, maxSessions: max }
      assertContract(sessionsResponseSchema, attachBody)
      return reply(res, 200, attachBody)
    }
    if (url.pathname.endsWith("/detach") && req.method === "POST" && !this.options.noSessionRoutes) {
      const parsed = parseSessionBody(body)
      if (!parsed.ok) return reply(res, parsed.status, { error: parsed.error })
      this.detachBodies.push({ id, holder: parsed.body.holder })
      if (this.options.detachStatus) return reply(res, this.options.detachStatus, { error: "detach failed" })
      const held = this.sessions.get(id) ?? 0
      const holders = this.holders(id)
      if (parsed.body.holder !== undefined && !holders.has(parsed.body.holder)) {
        const noopBody = { sessions: held, maxSessions: this.maxSessions.get(id) ?? 1 }
        assertContract(sessionsResponseSchema, noopBody)
        return reply(res, 200, noopBody)
      }
      if (parsed.body.holder !== undefined) holders.delete(parsed.body.holder)
      const remaining = Math.max(held - 1, 0)
      this.sessions.set(id, remaining)
      const detachBody = { sessions: remaining, maxSessions: this.maxSessions.get(id) ?? 1 }
      assertContract(sessionsResponseSchema, detachBody)
      return reply(res, 200, detachBody)
    }
    if (req.method === "DELETE") {
      const attached = this.sessions.get(id) ?? 0
      if (attached > 0 && url.searchParams.get("force") !== "true") {
        return reply(res, 409, { error: "computer has attached sessions", sessions: attached })
      }
      this.removed.push(id)
      this.states.delete(id)
      const deleteBody = { ok: true }
      assertContract(suspendResponseSchema, deleteBody)
      return reply(res, 200, deleteBody)
    }
    if (url.pathname.endsWith("/exec") && req.method === "POST") {
      if (this.options.execStatus) return reply(res, this.options.execStatus, { error: "exec failed" })
      const parsed = JSON.parse(body) as { argv: string[]; timeoutSec: number }
      assertContract(execRequestSchema, parsed)
      this.execs.push({ id, argv: parsed.argv, timeoutSec: parsed.timeoutSec })
      if (this.states.get(id) !== "running") return reply(res, 409, { error: "sandbox not running", state: this.states.get(id) })
      const out = this.runExec(id, parsed.argv, parsed)
      assertContract(execResponseSchema, out)
      return reply(res, 200, out)
    }
    if (url.pathname.endsWith("/suspend")) {
      this.suspended.push(id)
      this.states.set(id, "stopped")
      this.options.onSuspend?.()
      const suspendBody = { ok: true, snapshot: `snap-${id}-0`, state: "stopped" }
      assertContract(suspendResponseSchema, suspendBody)
      return reply(res, 200, suspendBody)
    }
    if (url.pathname.endsWith("/resume")) {
      this.resumed.push(id)
      if (!this.states.has(id)) return reply(res, 404, { error: "not found" })
      // Restore into a NEW computer: the real controller's behaviour.
      const newId = `cmp-restored-${(this.nextId++).toString().padStart(3, "0")}`
      this.states.set(newId, "running")
      this.states.delete(id)
      const resumeBody = { ok: true, id: newId, state: "running" }
      assertContract(resumeResponseSchema, resumeBody)
      return reply(res, 201, resumeBody)
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
    if (script.startsWith("cat ") && script.includes(".agentproto-daemon.token")) {
      return this.daemonToken ? { exitCode: 0, stdout: this.daemonToken, stderr: "" } : { exitCode: 1, stdout: "", stderr: "" }
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
        this.daemonToken = /--auth-token '([^']*)'/.exec(script)?.[1]
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
  /** The --auth-token recorded by the last serve command (the token file). */
  daemonToken: string | undefined = undefined
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

type ParsedSessionBody =
  | { ok: true; body: { holder?: string } }
  | { ok: false; status: 400; error: string }

/** A body-less attach/detach is the legacy `{}`; a body must match
 *  `attachRequestSchema` (the `holder` may be absent). A malformed body is
 *  a request error (400), never an exception escaping the handler. */
function parseSessionBody(body: string): ParsedSessionBody {
  if (body.trim() === "") return { ok: true, body: {} }
  try {
    const parsed: unknown = JSON.parse(body)
    return { ok: true, body: attachRequestSchema.parse(parsed) }
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : "invalid session body" }
  }
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
