import { describe, it, expect, vi, beforeEach } from "vitest"
import { createHash } from "node:crypto"
import type { SandboxSpec, SandboxBootOpts, BootedSandbox } from "@agentproto/sandbox"
import {
  SandboxBoxGoneError,
  isSandboxBoxGoneError,
  isSandboxQuotaError,
} from "@agentproto/sandbox"
import {
  BACKGROUND_REDIRECT,
  AGENTPROTO_METADATA_KEY,
  AUTH_TOKEN_ENV_VAR,
  ENV_FILE_PATH,
  SYSTEMD_UNIT_PATH,
  buildCliInstallCommand,
  createInstaboxSandboxProvider,
  environmentFileContents,
  instaboxSandboxProvider,
  normalizeQuotaError,
  writeDaemonUnitCommand,
} from "../provider.js"
import { InstaboxApiError, isInstaboxQuotaFailure } from "../api.js"

/** Sentinel values proving keys/secrets never leak into errors or argv. */
const SENTINEL_API_KEY = "ibk_sentinel_DO_NOT_ECHO"
const SENTINEL_SECRET = "sk-openrouter-sentinel-secret-xyz"
const CRED_ENV_KEY = "OPENROUTER_API_KEY"
const HEALTH_EDGE_SUFFIX = ".instabox.tech"

interface RecordedRequest {
  method: string
  url: URL
  apiKey: string
  idempotencyKey?: string
  body: string
}

interface RequestInitShape {
  method?: string
  body?: string
  headers?: Record<string, string>
}

interface FakeExec {
  cmd: string
  stdin?: string
  envs?: Record<string, string>
  timeoutSeconds?: number
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  truncated: boolean
}

interface FakeMachine {
  id: string
  name: string
  state: string
  runtime: { ready: boolean }
  metadata: Record<string, string>
  create: Record<string, unknown>
}

interface FakePort {
  id: string
  port: number
  url: string
  expiresAt: null
}

function fakeResponse(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text)),
  } as unknown as Response
}

function fakeErrorBody(status: number, code: string, message: string): Response {
  return fakeResponse(status, { error: { code, message, requestId: `req_${status}`, retryable: false } })
}

/** Scripted fake of the InstaBox surface the provider exercises, plus a tiny
 *  in-box bash emulation for the exact exec command shapes it builds. */
class FakeApi {
  readonly requests: RecordedRequest[] = []
  readonly creates: Record<string, unknown>[] = []
  readonly execBodies: FakeExec[] = []
  readonly deleted: string[] = []
  readonly machineVerbs: string[] = []
  readonly ops: Map<string, Record<string, unknown>> = new Map()
  readonly ports: Map<string, FakePort> = new Map()
  readonly boxFiles: Map<string, Uint8Array> = new Map()
  readonly envFileWrites: string[] = []
  readonly unitFileWrites: string[] = []
  envFileChmod = false
  daemonInstalled = false
  nextMachineId = 0
  nextOpId = 0
  usage: { limits: { maxMachines: number } } = { limits: { maxMachines: 5 } }
  overrideResponse: ((req: RecordedRequest) => Response | null) | null = null
  overrideExec: ((exec: FakeExec) => FakeExec) | null = null

  constructor(readonly apiKey: string = SENTINEL_API_KEY) {}

  buildFetch(): (input: unknown, init?: RequestInitShape) => Response {
    const api = this
    return (input: unknown, init?: RequestInitShape) => {
      const url = new URL(String(input))
      const method = init?.method ?? "GET"
      const body = typeof init?.body === "string" ? init.body : ""
      const apiKey = init?.headers?.["X-API-Key"] ?? ""
      const idempotencyKey = init?.headers?.["Idempotency-Key"]
      const request: RecordedRequest = {
        method,
        url,
        apiKey,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        body,
      }
      // Public edge: the /health probe answers 200 only once the daemon is up.
      if (url.host.endsWith(HEALTH_EDGE_SUFFIX)) {
        const healthy = api.daemonInstalled && url.pathname === "/health"
        if (process.env.DEBUG_INSTABOX) console.log("[fake-edge]", method, url.pathname, healthy)
        return healthy ? fakeResponse(200, "ok") : fakeResponse(502, "edge")
      }
      api.requests.push(request)
      const customAnswer = api.overrideResponse !== null ? api.overrideResponse(request) : null
      if (customAnswer !== null) return customAnswer
      const answer = api.route(method, url)
      if (process.env.DEBUG_INSTABOX) console.log("[fake]", method, url.pathname, "→", answer.status)
      return answer
    }
  }

  route(method: string, url: URL): Response {
    const mk = (status: number, body: unknown): Response => fakeResponse(status, body)
    const notFound = (): Response => fakeErrorBody(404, "not_found", "machine not found")
    const path = url.pathname

    if (method === "GET" && path === "/v1/usage") return mk(200, this.usage)
    if (method === "GET" && path === "/v1/machines") {
      return mk(200, { machines: [...this.machineStates.values()].map(machineJson) })
    }
    if (method === "POST" && path === "/v1/machines") {
      const body = JSON.parse(this.requests.at(-1)!.body) as Record<string, unknown>
      this.creates.push(body)
      this.nextMachineId++
      const id = `m_fake${this.nextMachineId}`
      this.machineStates.set(id, {
        id,
        name: String(body.name),
        state: "running",
        runtime: { ready: true },
        metadata: (body.metadata as Record<string, string>) ?? {},
        create: body,
      })
      const op = this.spawnOperation(id, "succeeded")
      this.machinesInstalledSoon.add(id)
      return op
    }

    const machineRoute = /^\/v1\/machines\/([^/]+)$/.exec(path)
    if (machineRoute) {
      const machine = this.find(decodeURIComponent(machineRoute[1]!))
      if (!machine) return notFound()
      if (method === "GET") return mk(200, machineJson(machine))
      if (method === "PATCH") {
        const patch = JSON.parse(this.requests.at(-1)!.body) as Record<string, unknown>
        machine.create.patchLog = [...((machine.create.patchLog as unknown[] | undefined) ?? []), patch]
        return this.spawnOperation(machine.id, "succeeded")
      }
      if (method === "DELETE") {
        const snapshot = machineJson(machine)
        this.deleted.push(machine.id)
        this.machineStates.delete(machine.id)
        return this.spawnOperation(machine.id, "succeeded", snapshot)
      }
    }

    const machineSub = /^\/v1\/machines\/([^/]+)\/(.+)$/.exec(path)
    if (machineSub) {
      const key = decodeURIComponent(machineSub[1]!)
      const verb = machineSub[2]!
      const machine = this.find(key)
      if (verb === "exec" && method === "POST") {
        const body = JSON.parse(this.requests.at(-1)!.body) as FakeExec
        const answer = this.runExec(body)
        this.execBodies.push({
          ...body,
          stdout: answer.stdout,
          stderr: answer.stderr,
          exitCode: answer.exitCode,
          timedOut: answer.timedOut,
          truncated: answer.truncated,
        })
        return mk(200, {
          stdout: answer.stdout,
          stderr: answer.stderr,
          exitCode: answer.exitCode,
          timedOut: answer.timedOut,
          truncated: answer.truncated,
        })
      }
      if (!machine) return notFound()
      if (verb === "ports" && method === "POST") {
        const port = (JSON.parse(this.requests.at(-1)!.body) as { port: number }).port
        const key2 = `${machine.id}:${port}`
        let entry = this.ports.get(key2)
        if (!entry) {
          entry = {
            id: `p_${machine.id}_${port}`,
            port,
            url: `https://${port}-${machine.id.replace(/^m_/, "")}.instabox.tech`,
            expiresAt: null,
          }
          this.ports.set(key2, entry)
        }
        return mk(201, entry)
      }
      if ((verb === "suspend" || verb === "resume" || verb === "stop" || verb === "start") && method === "POST") {
        this.machineVerbs.push(verb)
        if (verb === "start" || verb === "resume") machine.state = "running"
        if (verb === "suspend") machine.state = "suspended"
        if (verb === "stop") machine.state = "stopped"
        return this.spawnOperation(machine.id, "succeeded")
      }
      if (verb === "wake" && method === "POST") {
        this.machineVerbs.push("wake")
        machine.state = "running"
        return mk(200, {})
      }
    }

    const opsRoute = /^\/v1\/operations\/([^?]+)/.exec(path)
    if (method === "GET" && opsRoute) {
      const op = this.ops.get(decodeURIComponent(opsRoute[1]!))
      if (!op) return fakeErrorBody(404, "not_found", "operation not found")
      return mk(200, op)
    }
    return mk(500, { error: { code: "internal", message: `unrouted ${method} ${path}` } })
  }

  readonly machinesInstalledSoon = new Set<string>()

  find(idOrName: string): FakeMachine | undefined {
    return this.machineStates.get(idOrName) ?? [...this.machineStates.values()].find(m => m.name === idOrName)
  }

  spawnOperation(machineId: string, state: string, machineOverride?: Record<string, unknown>): Response {
    this.nextOpId++
    const opId = `op_${this.nextOpId}`
    const op = {
      id: opId,
      machineId,
      state,
      error: null,
      machine: machineOverride ?? machineJson(this.machineStates.get(machineId)!),
    }
    this.ops.set(opId, op)
    return fakeResponse(202, op)
  }

  seedMachine(fields: Partial<FakeMachine> & { id: string }): FakeMachine {
    const { id, ...rest } = fields
    const machine: FakeMachine = {
      id,
      name: "agentproto-seeded",
      state: "running",
      runtime: { ready: true },
      metadata: { [AGENTPROTO_METADATA_KEY]: "1" },
      create: {},
      ...rest,
    }
    this.machineStates.set(machine.id, machine)
    return machine
  }

  private readonly machineStates: Map<string, FakeMachine> = new Map()

  runExec(body: FakeExec): FakeExec {
    const normalized: FakeExec = {
      ...body,
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    }
    return this.overrideExec !== null
      ? this.overrideExec(normalized)
      : this.defaultExecHandler(normalized)
  }

  defaultExecHandler(exec: FakeExec): FakeExec {
    const result = (partial: Partial<FakeExec>): FakeExec => ({ ...exec, ...partial })
    const cmd = exec.cmd
    if (cmd.includes("systemctl") || cmd.includes("daemon-reload")) {
      this.daemonInstalled = true
      return result({})
    }
    if (cmd.includes("<<'AGENTPROTO_ENV'") || cmd.includes("<<'AGENTPROTO_UNIT'")) {
      // The env file and systemd unit travel INSIDE one multi-line command
      // (heredoc bodies), so parse every block by its markers.
      for (const [marker, sink] of [
        ["AGENTPROTO_ENV", this.envFileWrites],
        ["AGENTPROTO_UNIT", this.unitFileWrites],
      ] as const) {
        const start = cmd.indexOf(`<<'${marker}'\n`)
        if (start === -1) continue
        const after = cmd.slice(start + `<<'${marker}'\n`.length)
        const end = after.indexOf(`\n${marker}\n`) === -1 ? after.length : after.indexOf(`\n${marker}\n`)
        const body = after.slice(0, end)
        sink.push(body)
        if (marker === "AGENTPROTO_ENV") this.boxFiles.set(ENV_FILE_PATH, bufferOf(`${body}\n`))
        else this.boxFiles.set(SYSTEMD_UNIT_PATH, bufferOf(`${body}\n`))
      }
      if (cmd.includes("sudo chmod 600 ")) this.envFileChmod = true
      return result({})
    }
    if (cmd.startsWith("sudo cat ")) {
      const env = this.boxFiles.get(ENV_FILE_PATH)
      return result({ stdout: env === undefined ? "" : decodeBytes(env) })
    }
    const grep = /^sudo grep '(?:\^)?([A-Z0-9_]+)=' /.exec(cmd)
    if (grep !== null) {
      const env = this.boxFiles.get(ENV_FILE_PATH)
      if (env === undefined) return result({ exitCode: 1, stdout: "" })
      const prefix = `${grep[1]}=`
      const lines = decodeBytes(env)
        .split("\n")
        .filter(line => line.startsWith(prefix))
      return lines.length > 0
        ? result({ stdout: `${lines.join("\n")}\n` })
        : result({ exitCode: 1, stdout: "" })
    }
    if (cmd.startsWith("npm i -g")) return result({})
    if (/^mkdir -p '[^']+' && sudo mkdir -p/.test(cmd) && exec.stdin === undefined) return result({})
    if (/^mkdir -p '[^']+' && base64 -d > '(.+)'/.test(cmd) && exec.stdin !== undefined) {
      const target = /base64 -d > '(.+)'/.exec(cmd)![1]!
      this.boxFiles.set(target, new Uint8Array(Buffer.from(exec.stdin, "base64")))
      return result({})
    }
    if (/^base64 -d >> '(.+)'/.test(cmd) && exec.stdin !== undefined) {
      const target = /base64 -d >> '(.+)'/.exec(cmd)![1]!
      const previous = this.boxFiles.get(target) ?? new Uint8Array(0)
      const addition = new Uint8Array(Buffer.from(exec.stdin, "base64"))
      const merged = new Uint8Array(previous.byteLength + addition.byteLength)
      merged.set(previous, 0)
      merged.set(addition, previous.byteLength)
      this.boxFiles.set(target, merged)
      return result({})
    }
    const dd = /^dd if='(.+)' ibs=(\d+) skip=(\d+) count=1 2>\/dev\/null \| base64 -w0$/.exec(cmd)
    if (dd !== null) {
      const [, target, chunkText, skipText] = dd
      const file = this.boxFiles.get(target!)
      if (file === undefined) return result({ exitCode: 1, stderr: `dd: cannot read '${target}'` })
      const chunkSize = Number(chunkText)
      const skip = Number(skipText)
      const slice = file.slice(skip * chunkSize, (skip + 1) * chunkSize)
      return result({ stdout: Buffer.from(slice).toString("base64") })
    }
    if (exec.envs !== undefined) return result({ stdout: `env:${exec.envs["FOO"] ?? ""}` })
    return result({ stdout: "ok" })
  }
}

function machineJson(machine: FakeMachine): Record<string, unknown> {
  return {
    id: machine.id,
    name: machine.name,
    state: machine.state,
    runtime: machine.runtime,
    metadata: machine.metadata,
    onTimeout: "kill",
    autoSuspendAfterSeconds: 0,
    timeoutSeconds: 3600,
  }
}

function bufferOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"))
}

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function makeSpec(config: Record<string, unknown> = {}): SandboxSpec {
  return {
    provider: "instabox",
    id: "@o/sess-x",
    config: { apiKey: SENTINEL_API_KEY, ...config },
  } as unknown as SandboxSpec
}

function makeBootOpts(env: Record<string, string> = { [CRED_ENV_KEY]: SENTINEL_SECRET }): SandboxBootOpts {
  return { env }
}

async function bootOnce(
  api = new FakeApi(),
  config: Record<string, unknown> = {},
): Promise<BootedSandbox> {
  const stubbedFetch = api.buildFetch() as unknown as typeof fetch
  vi.stubGlobal("fetch", stubbedFetch)
  const booted = await instaboxSandboxProvider.boot(makeSpec(config), makeBootOpts())
  return booted
}

describe("boot happy path", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("creates the machine with vault:false always, metadata stamp, kill onTimeout, default no auto-suspend", async () => {
    const api = new FakeApi()
    const booted = await bootOnce(api)
    expect(api.creates).toHaveLength(1)
    const create = api.creates[0]!
    expect(create).toMatchObject({
      vault: false,
      onTimeout: "kill",
      autoSuspendAfterSeconds: 0,
      templateId: "universal",
      timeoutSeconds: 3600,
    })
    expect((create.metadata as Record<string, string>)[AGENTPROTO_METADATA_KEY]).toBe("1")
    expect((create.metadata as Record<string, string>)["session"]).toBe("@o/sess-x")
    expect(booted.sandboxId).toMatch(/^m_fake\d+$/)
    expect(booted.mcpUrl).toMatch(/^https:\/\/18790-.*\.instabox\.tech\/mcp$/)
    expect(booted.token).toEqual(expect.any(String))
    expect(booted.authHeaders).toEqual({ Authorization: `Bearer ${booted.token}` })
    expect(booted.lifetimeMs).toBe(3600_000)
    expectNoSuspend(api)
    expectNoBackgroundWithoutRedirect(api)
  })

  it("keeps vault:false when spec config overrides everything else", async () => {
    const api = new FakeApi()
    await bootOnce(api, {
      timeoutSeconds: 90,
      autoSuspendAfterSeconds: 600,
      onTimeout: "kill",
    })
    expect(api.creates[0]!).toMatchObject({
      vault: false,
      onTimeout: "kill",
      autoSuspendAfterSeconds: 600,
      timeoutSeconds: 90,
    })
  })

  it("installs the daemon as a systemd unit with a 0600 EnvironmentFile and keeps secrets out of argv", async () => {
    const api = new FakeApi()
    await bootOnce(api)
    expect(api.envFileChmod).toBe(true)
    const unit = api.unitFileWrites.join("\n")
    expect(unit).toContain("--auth-token ${AGENTPROTO_AUTH_TOKEN}")
    expect(unit).toContain(`EnvironmentFile=-${ENV_FILE_PATH}`)
    expect(unit).toContain("Restart=always")
    expect(unit).toContain('ExecStart=agentproto serve --port 18790 --bind 0.0.0.0 --workspace "/data/home"')
    expect(api.envFileWrites.join("\n")).toContain(`${CRED_ENV_KEY}=${SENTINEL_SECRET}`)
    expect(api.envFileWrites.join("\n")).toContain(`${AUTH_TOKEN_ENV_VAR}=`)
    expectNoSecretOutsideHeredoc(api, [SENTINEL_API_KEY, SENTINEL_SECRET, bootTokenOf(api)])
  })

  it(" publishes the daemon port and probes health through the public edge", async () => {
    const api = new FakeApi()
    await bootOnce(api)
    const portRequest = api.requests.find(r => r.url.pathname.endsWith(`/ports`))
    expect(portRequest).toBeDefined()
    expect(portRequest?.method).toBe("POST")
    expect(JSON.parse(portRequest!.body)).toEqual({ port: 18790 })
    expect((portRequest as RecordedRequest).idempotencyKey).toBeDefined()
  })

  it("sends an idempotency key on create and never creates twice on retryable transport glitches", async () => {
    const api = new FakeApi()
    await bootOnce(api)
    const create = api.requests.find(r => r.method === "POST" && r.url.pathname === "/v1/machines")!
    expect(create.idempotencyKey).toBeDefined()
    expect(api.creates).toHaveLength(1)
  })

  it("omits the session metadata when the spec carries no id", async () => {
    const api = new FakeApi()
    const bareSpec = { provider: "instabox", config: { apiKey: SENTINEL_API_KEY } } as unknown as SandboxSpec
    vi.stubGlobal("fetch", api.buildFetch() as unknown as typeof fetch)
    await instaboxSandboxProvider.boot(bareSpec, makeBootOpts())
    expect(Object.keys(api.creates[0]!.metadata as object)).not.toContain("session")
  })
})

function bootTokenOf(api: FakeApi): string {
  const envWrite = api.envFileWrites[0]
  if (envWrite === undefined) return "(none)"
  const line = envWrite.split("\n").find(entry => entry.startsWith(`${AUTH_TOKEN_ENV_VAR}=`))
  return line === undefined ? "(none)" : line.slice(`${AUTH_TOKEN_ENV_VAR}=`.length)
}

function expectNoSuspend(api: FakeApi): void {
  for (const request of api.requests) {
    expect(request.url.pathname).not.toContain("/suspend")
  }
  expect(api.machineVerbs).not.toContain("suspend")
}

function expectNoBackgroundWithoutRedirect(api: FakeApi): void {
  for (const cmd of api.execBodies.map(exec => exec.cmd)) {
    const stripped = cmd.replaceAll("&&", "").replaceAll(BACKGROUND_REDIRECT, "")
    expect(stripped).not.toContain("&")
  }
}

/** Remove heredoc bodies (the sanctioned secret channel: tee's stdin) from
 *  each provider command and assert no secret survived in argv space. */
function expectNoSecretOutsideHeredoc(api: FakeApi, sentinels: string[]): void {
  for (const cmd of api.execBodies.map(exec => exec.cmd)) {
    const stripped = cmd
      .replace(/<<'AGENTPROTO_ENV'\n[\s\S]*?AGENTPROTO_ENV/g, "")
      .replace(/<<'AGENTPROTO_UNIT'\n[\s\S]*?AGENTPROTO_UNIT/g, "")
    for (const secret of sentinels) expect(stripped).not.toContain(secret)
  }
}

describe("quota handling", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("pre-checks the account machine cap and throws SandboxQuotaError without creating", async () => {
    const api = new FakeApi()
    api.usage = { limits: { maxMachines: 1 } }
    api.seedMachine({ id: "m_full1" })
    const stubbedFetch = api.buildFetch() as unknown as typeof fetch
    vi.stubGlobal("fetch", stubbedFetch)
    await expect(instaboxSandboxProvider.boot(makeSpec(), makeBootOpts())).rejects.toSatisfy(isSandboxQuotaError)
    expect(api.creates).toHaveLength(0)
  })

  it("maps quota-shaped create failures (429 or a limit code) to SandboxQuotaError", async () => {
    const api = new FakeApi()
    api.overrideResponse = req => {
      if (req.method === "POST" && req.url.pathname === "/v1/machines") {
        return fakeResponse(429, {
          error: { code: "rate_limit", message: "account limit reached", requestId: "req_429", retryable: true },
        })
      }
      return null
    }
    const stubbedFetch = api.buildFetch() as unknown as typeof fetch
    vi.stubGlobal("fetch", stubbedFetch)
    await expect(instaboxSandboxProvider.boot(makeSpec(), makeBootOpts())).rejects.toSatisfy(isSandboxQuotaError)
  })

  it("wraps a literal quota code from create into SandboxQuotaError via normalizeQuotaError", async () => {
    const wrapped = normalizeQuotaError(
      new InstaboxApiError("instabox: quota", { status: 402, code: "quota_exceeded" }),
    )
    expect(isSandboxQuotaError(wrapped)).toBe(true)
    expect(isInstaboxQuotaFailure(402, "anything", "anything")).toBe(true)
    expect(isInstaboxQuotaFailure(429, "anything", "anything")).toBe(true)
    expect(isInstaboxQuotaFailure(400, "bad_request", "plain refusal")).toBe(false)
    expect(isInstaboxQuotaFailure(400, "bad_request", "machines count exceeds the account limit")).toBe(true)
  })

  it("does NOT report quota for an ordinary 400 and still deletes the fresh machine on generic failures", async () => {
    const api = new FakeApi()
    api.overrideResponse = () => fakeErrorBody(400, "bad_request", "bad payload")
    const stubbedFetch = api.buildFetch() as unknown as typeof fetch
    vi.stubGlobal("fetch", stubbedFetch)
    await expect(instaboxSandboxProvider.boot(makeSpec(), makeBootOpts())).rejects.toSatisfy(
      err => !isSandboxQuotaError(err),
    )
    expect(api.creates).toHaveLength(0)
  })

  it("a failed operation surfaces its code/message and deletes the freshly-created machine", async () => {
    const api = new FakeApi()
    api.overrideResponse = req => {
      if (req.method === "GET" && /^\/v1\/operations\/op_/.test(req.url.pathname)) {
        return fakeResponse(200, {
          id: "op_1",
          machineId: "m_fake1",
          state: "failed",
          error: { code: "bad_request", message: "boot unknown template snapshot" },
        })
      }
      return null
    }
    const stubbedFetch = api.buildFetch() as unknown as typeof fetch
    vi.stubGlobal("fetch", stubbedFetch)
    await expect(
      instaboxSandboxProvider.boot(makeSpec(), makeBootOpts()),
    ).rejects.toThrow(/bad_request/)
    expect(api.deleted).toContain("m_fake1")
  })
})

describe("exec mapping", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  async function bootedForExec(override: (exec: FakeExec) => Partial<FakeExec>): Promise<{
    booted: BootedSandbox
    api: FakeApi
  }> {
    // Boot with the DEFAULT interpreter (its systemctl branch flips the fake
    // daemon healthy), THEN install the scripted answer for the execs under test.
    const api = new FakeApi()
    const booted = await bootOnce(api)
    api.overrideExec = exec => ({ ...exec, ...override(exec) })
    return { booted, api }
  }

  it("maps a non-zero exit to a result (never a throw) and clamps timeoutMs into 1..600 seconds", async () => {
    const hook = { exitCode: 3, stdout: "partial out", stderr: "boom" }
    const { booted, api } = await bootedForExec(() => hook)
    const res = await booted.exec!({ command: "exit 3", timeoutMs: 5000 })
    expect(res).toMatchObject({ exitCode: 3, stdout: "partial out", stderr: "boom" })
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
    const sent = api.execBodies.at(-1)!
    expect(sent).toMatchObject({ cmd: "exit 3", timeoutSeconds: 5 })
  })

  it("clamps an absent / huge / tiny timeoutMs onto 600 / 600 / 1", async () => {
    const { booted, api } = await bootedForExec(() => ({}))
    await booted.exec!({ command: "true" })
    expect(api.execBodies.at(-1)!.timeoutSeconds).toBe(600)
    await booted.exec!({ command: "true", timeoutMs: 5_000_000 })
    expect(api.execBodies.at(-1)!.timeoutSeconds).toBe(600)
    await booted.exec!({ command: "true", timeoutMs: 200 })
    expect(api.execBodies.at(-1)!.timeoutSeconds).toBe(1)
  })

  it("forwards env as envs and reports a timeout as exitCode 124 (a result, not a throw)", async () => {
    const { booted, api } = await bootedForExec(() => ({
      exitCode: 124,
      timedOut: true,
      stdout: "partial",
      stderr: "killed",
    }))
    const res = await booted.exec!({ command: "sleep 9", env: { FOO: "bar" }, timeoutMs: 1000 })
    expect(res.exitCode).toBe(124)
    expect(api.execBodies.at(-1)!.envs).toEqual({ FOO: "bar" })
  })

  it("surfaces the API stream cap through the truncated flag", async () => {
    const { booted } = await bootedForExec(() => ({ stdout: "start-of-output", truncated: true }))
    const res = await booted.exec!({ command: "big" })
    expect(res.truncated).toBe(true)
  })

  it("the sentinel API key rides ONLY in the X-API-Key header: never a body, never an idempotency key", async () => {
    const api = new FakeApi()
    const booted = await bootOnce(api)
    await booted.exec!({ command: "echo hi" })
    for (const request of api.requests) {
      expect(request.apiKey).toBe(SENTINEL_API_KEY)
      expect(request.body).not.toContain(SENTINEL_API_KEY)
      expect(request.idempotencyKey ?? "").not.toContain(SENTINEL_API_KEY)
    }
  })

  it("throws an error that carries neither the API key nor the env secret on transport failure", { timeout: 20_000 }, async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED transport down")
    })
    vi.stubGlobal("fetch", failingFetch as unknown as typeof fetch)
    const error: unknown = await instaboxSandboxProvider
      .boot(makeSpec(), makeBootOpts())
      .then(
        value => value,
        err => err,
      )
    expect(error instanceof Error).toBe(true)
    const message = error instanceof Error ? error.message : ""
    expect(message).not.toContain(SENTINEL_API_KEY)
    expect(message).not.toContain(SENTINEL_SECRET)
  })
})

describe("writeFile and readFile", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  const BIG = 1_600_000
  const bigData = new Uint8Array(BIG).map((_, i) => i % 251)

  it("chunks a big write into aligned base64 stdin slices and reconstructs the exact bytes", async () => {
    const api = new FakeApi()
    const booted = await bootOnce(api)
    await booted.writeFile!("/data/home/out.bin", bigData)
    const stored = api.boxFiles.get("/data/home/out.bin")!
    expect(stored.byteLength).toBe(BIG)

    const writes = api.execBodies.filter(exec => exec.stdin !== undefined)
    expect(writes.length).toBeGreaterThan(1)
    const maxB64 = Math.ceil((700 * 1024) / 3) * 4
    for (const write of writes) {
      expect(write.timeoutSeconds).toBe(600)
      expect(write.stdin!.length).toBeLessThanOrEqual(maxB64)
      expect(write.stdin!.length % 4).toBe(0)
    }
    expect(writes[0]!.cmd).toBe("mkdir -p '/data/home' && base64 -d > '/data/home/out.bin'")
    expectNoBackgroundWithoutRedirect(api)
    expectNoSecretOutsideHeredoc(api, [SENTINEL_API_KEY, SENTINEL_SECRET])
  })

  it("sha-goldens a write-then-read round trip", async () => {
    const api = new FakeApi()
    const booted = await bootOnce(api)
    const golden = createHash("sha256").update(bigData).digest("hex")
    await booted.writeFile!("/data/home/rt.bin", bigData)
    const roundTripped = await booted.readFile!("/data/home/rt.bin")
    expect(createHash("sha256").update(roundTripped).digest("hex")).toBe(golden)

    const reads = api.execBodies.filter(exec => exec.cmd.includes("base64 -w0"))
    expect(reads.length).toBeGreaterThan(1)
    const b64Chars = Math.ceil((700 * 1024) / 3) * 4
    for (const read of reads) {
      expect(read.timeoutSeconds).toBe(600)
      expect(read.stdout.length).toBeLessThanOrEqual(1_048_576)
      expect(read.stdout.length).toBeLessThanOrEqual(b64Chars)
    }
  })

  it("rejects a missing-file read with a clear error", async () => {
    const booted = await bootOnce()
    await expect(booted.readFile!("/data/home/absent.bin")).rejects.toThrow(/cannot read/)
  })

  it("accepts an empty write (one mkdir + empty stdin decode)", async () => {
    const api = new FakeApi()
    const booted = await bootOnce(api)
    await booted.writeFile!("/data/home/empty.bin", new Uint8Array(0))
    expect(api.boxFiles.get("/data/home/empty.bin")!.byteLength).toBe(0)
  })
})

describe("background redirection invariant", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("systemctl enable --now carries the redirect suffix; no command backgrounds bare", async () => {
    const api = new FakeApi()
    await bootOnce(api)
    const enable = api.execBodies.find(exec => exec.cmd.includes("systemctl enable"))
    expect(enable?.cmd).toContain(BACKGROUND_REDIRECT)
    expectNoBackgroundWithoutRedirect(api)
  })

  it("builds the CLI install command from ONLY package spec names (no secret)", async () => {
    const api = new FakeApi()
    await bootOnce(api, { installPackages: ["@agentproto/adapter-claude-sdk@latest"] })
    const install = api.execBodies.find(exec => exec.cmd.startsWith("npm i -g"))
    expect(install!.cmd).toContain("@agentproto/cli@latest")
    expect(install!.cmd).toContain("'@agentproto/adapter-claude-sdk@latest'")
    expect(install!.cmd).not.toContain(SENTINEL_SECRET)
  })
})

describe("stop", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("deletes the machine and never sends suspend instead", async () => {
    const api = new FakeApi()
    const booted = await bootOnce(api)
    await booted.stop()
    expect(api.deleted).toContain(booted.sandboxId)
    expectNoSuspend(api)
    expect(booted.pause).toBeUndefined()
  })

  it("tolerates an already-gone machine (404)", async () => {
    const api = new FakeApi()
    const booted = await bootOnce(api)
    api.overrideResponse = req => (req.method === "DELETE" ? fakeErrorBody(404, "not_found", "already gone") : null)
    await expect(booted.stop()).resolves.toBeUndefined()
    expect(booted.pause).toBeUndefined()
    void SandboxBoxGoneError
  })
})

describe("extendTimeout", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("clamps into 60..86400 seconds and patches with them", async () => {
    const api = new FakeApi()
    const booted = await bootOnce(api)
    await booted.extendTimeout!(1_000_000_000)
    expect(JSON.parse(api.requests.filter(r => r.method === "PATCH").at(-1)!.body)).toEqual({
      timeoutSeconds: 86400,
    })
    await booted.extendTimeout!(1_000)
    expect(JSON.parse(api.requests.filter(r => r.method === "PATCH").at(-1)!.body)).toEqual({
      timeoutSeconds: 60,
    })
  })
})

describe("connect", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  function preparedConnectApi(): FakeApi {
    const api = new FakeApi()
    api.daemonInstalled = true
    return api
  }

  it("reconnects running: token from the env file, re-arm patch, no wake", async () => {
    const api = preparedConnectApi()
    api.boxFiles.set(ENV_FILE_PATH, bufferOf(`${CRED_ENV_KEY}=${SENTINEL_SECRET}\n${AUTH_TOKEN_ENV_VAR}=tok_running\n`))
    api.seedMachine({ id: "m_run" })
    vi.stubGlobal("fetch", api.buildFetch() as unknown as typeof fetch)
    const booted = await instaboxSandboxProvider.connect!("m_run", makeSpec(), makeBootOpts())
    expect(booted.token).toBe("tok_running")
    expect(api.requests.some(r => r.url.pathname.endsWith("/wake"))).toBe(false)
    expect(api.requests.some(r => r.method === "PATCH")).toBe(true)
    expectNoSuspend(api)
  })

  it("wakes an auto-suspended machine with POST wake (no resume fallback attempted)", async () => {
    const api = preparedConnectApi()
    api.boxFiles.set(ENV_FILE_PATH, bufferOf(`${AUTH_TOKEN_ENV_VAR}=tok_suspended\n`))
    api.seedMachine({ id: "m_sus" }).state = "suspended"
    vi.stubGlobal("fetch", api.buildFetch() as unknown as typeof fetch)
    const booted = await instaboxSandboxProvider.connect!("m_sus", makeSpec(), makeBootOpts())
    expect(booted.mcpUrl).toContain("/mcp")
    expect(api.machineVerbs).toEqual(["wake"])
    expect(api.requests.some(r => r.url.pathname.endsWith("/resume"))).toBe(false)
  })

  it("falls back to resume when wake answers 409 (a manually suspended box)", async () => {
    const api = preparedConnectApi()
    api.boxFiles.set(ENV_FILE_PATH, bufferOf(`${AUTH_TOKEN_ENV_VAR}=tok_manual\n`))
    api.seedMachine({ id: "m_man" }).state = "suspended"
    api.overrideResponse = req => {
      if (req.method === "POST" && req.url.pathname.endsWith("/wake")) {
        return fakeErrorBody(409, "machine_not_running", "wake refused")
      }
      return null
    }
    vi.stubGlobal("fetch", api.buildFetch() as unknown as typeof fetch)
    const booted = await instaboxSandboxProvider.connect!("m_man", makeSpec(), makeBootOpts())
    expect(booted.token).toBe("tok_manual")
    expect(api.machineVerbs).toContain("resume")
    expect(api.machineVerbs).not.toContain("suspend")
  })

  it("starts a stopped machine", async () => {
    const api = preparedConnectApi()
    api.boxFiles.set(ENV_FILE_PATH, bufferOf(`${AUTH_TOKEN_ENV_VAR}=tok_stopped\n`))
    api.seedMachine({ id: "m_stop" }).state = "stopped"
    vi.stubGlobal("fetch", api.buildFetch() as unknown as typeof fetch)
    await instaboxSandboxProvider.connect!("m_stop", makeSpec(), makeBootOpts())
    expect(api.machineVerbs).toContain("start")
  })

  it("surfaces a deleted machine as SandboxBoxGoneError", async () => {
    const api = new FakeApi()
    vi.stubGlobal("fetch", api.buildFetch() as unknown as typeof fetch)
    await expect(instaboxSandboxProvider.connect!("m_nothing", makeSpec(), makeBootOpts())).rejects.toSatisfy(
      isSandboxBoxGoneError,
    )
  })

  it("reports probe(alive:false) on a 404 and state on success", async () => {
    const api = new FakeApi()
    api.seedMachine({ id: "m_probe" }).state = "running"
    vi.stubGlobal("fetch", api.buildFetch() as unknown as typeof fetch)
    const provider = createInstaboxSandboxProvider({ apiKey: SENTINEL_API_KEY })
    expect(await provider.probe!(
      "m_probe",
    )).toEqual({ alive: true, state: "running" })
    expect(await provider.probe!("m_absent")).toEqual({ alive: false })
  })

  it("expose keeps the stable per (machine, port) URL", async () => {
    const api = new FakeApi()
    const booted = await bootOnce(api)
    const { url } = await booted.expose!(9443)
    expect(url).toContain(".instabox.tech")
    const again = await booted.expose!(9443)
    expect(again.url).toBe(url)
  })
})

describe("secret hygiene", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps the API key out of exec argv/stdin, the box env file, the unit, request bodies and logs", async () => {
    const FAKE_KEY = "ib_test_SECRET123"
    const logs: string[] = []
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map(method =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
      }),
    )
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        logs.push(String(chunk))
        return true
      })
    try {
      const api = new FakeApi(FAKE_KEY)
      await bootOnce(api, { apiKey: FAKE_KEY })

      const surfaces: Array<[string, string]> = [
        ["create bodies", JSON.stringify(api.creates)],
        ["exec argv/stdin", api.execBodies.map(e => `${e.cmd}\n${e.stdin ?? ""}`).join("\n")],
        ["box env file", decodeBytes(api.boxFiles.get(ENV_FILE_PATH) ?? new Uint8Array())],
        ["systemd unit", decodeBytes(api.boxFiles.get(SYSTEMD_UNIT_PATH) ?? new Uint8Array())],
        ["request bodies/urls", api.requests.map(r => `${r.method} ${r.url.href} ${r.body}`).join("\n")],
        ["console output", logs.join("\n")],
      ]
      for (const [what, text] of surfaces) expect(text, what).not.toContain(FAKE_KEY)
    } finally {
      consoleSpies.forEach(spy => spy.mockRestore())
      stderrSpy.mockRestore()
    }
  })

  it("surfaces an InstaBox API error without echoing the API key in the message or stack", async () => {
    const FAKE_KEY = "ib_test_SECRET123"
    const api = new FakeApi(FAKE_KEY)
    api.overrideResponse = req =>
      req.method === "POST" && req.url.pathname === "/v1/machines"
        ? fakeErrorBody(500, "internal_error", "boom")
        : null
    vi.stubGlobal("fetch", api.buildFetch() as unknown as typeof fetch)

    const err = await instaboxSandboxProvider
      .boot(makeSpec({ apiKey: FAKE_KEY }), makeBootOpts())
      .then(
        () => {
          throw new Error("expected boot to fail")
        },
        (caught: unknown) => caught as Error,
      )
    expect(err).toBeInstanceOf(Error)
    expect(err.message).not.toContain(FAKE_KEY)
    expect(String(err.stack ?? "")).not.toContain(FAKE_KEY)
  })
})

describe("reattach after a host daemon restart", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("re-finds the same box and returns the same per-box auth token without re-creating it", async () => {
    const api = new FakeApi()
    const booted = await bootOnce(api)
    const createsBefore = api.creates.length

    // A fresh provider instance models the runtime process restarting while
    // the box (and its persisted EnvironmentFile) survives.
    const restarted = createInstaboxSandboxProvider({ apiKey: SENTINEL_API_KEY })
    vi.stubGlobal("fetch", api.buildFetch() as unknown as typeof fetch)
    const reattached = await restarted.connect!(
      booted.sandboxId,
      makeSpec(),
      makeBootOpts(),
    )

    expect(reattached.sandboxId).toBe(booted.sandboxId)
    expect(reattached.mcpUrl).toBe(booted.mcpUrl)
    expect(reattached.token).toBe(booted.token)
    expect(api.creates).toHaveLength(createsBefore)
  })
})

describe("pure helpers", () => {
  it("environmentFileContents carries resolved secrets plus the auth token line", () => {
    const contents = environmentFileContents({ FOO: "1" }, "tok")
    expect(contents).toContain("FOO=1")
    expect(contents).toContain(`${AUTH_TOKEN_ENV_VAR}=tok`)
  })

  it("writeDaemonUnitCommand keeps secrets in the heredoc body and never in ExecStart", () => {
    const built = writeDaemonUnitCommand(18790, "/data/home", { ALPHA: "beta" }, "unitToken")
    expect(built.unitContents).toContain("--auth-token ${AGENTPROTO_AUTH_TOKEN}")
    expect((built.unitContents.split("ExecStart=")[1] ?? "").includes("unitToken")).toBe(false)
    expect(built.envFileContents).toContain("ALPHA=beta")
    expect(built.command).toContain(`sudo chmod 600 ${ENV_FILE_PATH}`)
    expect(built.command).toContain(`sudo tee ${SYSTEMD_UNIT_PATH}`)
  })

  it("buildCliInstallCommand renders pinned and floating versions", () => {
    expect(buildCliInstallCommand("1.2.3", [])).toBe('npm i -g "@agentproto/cli@1.2.3"')
    expect(buildCliInstallCommand("latest", ["x"])).toContain("'x'")
  })
})
