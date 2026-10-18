/**
 * Tiny typed InstaBox API client (https://instabox.sh, API
 * https://api.instabox.sh) over injectable `fetch`. Shapes measured on a real
 * account on 2026-10-18:
 *
 * - auth: `X-API-Key: ibk_...` (NEVER logged and never echoed in an error).
 * - every lifecycle verb (`POST /v1/machines`, suspend/resume/stop/start,
 *   ports, DELETE) returns 202 `{id:"op_...", machineId, state:"queued"}` and
 *   is awaited via `GET /v1/operations/{id}?wait=25s` long-polling.
 * - errors: `{"error":{"code","message","requestId","retryable","operationId"}}`.
 * - a publish-port request is idempotent (201 first, 200 if already
 *   published) and both creates get an idempotency header, but `exec` is NOT
 *   retried on transport errors.
 */

/** Machine states reported by `GET /v1/machines/{id}` right now. */
export type InstaboxMachineState = "running" | "suspended" | "stopped"

/** The action a machine takes when its `timeoutSeconds` lifetime elapses. */
export type InstaboxOnTimeout = "pause" | "kill"

export interface InstaboxMachine {
  /** Canonical id, `m_...` (a GET still accepts the machine NAME for direct
   *  lookups, but `files`, `wake` and `ports` need the canonical id). */
  id: string
  state: InstaboxMachineState | string
  desiredState?: string
  name?: string
  runtime?: { ready?: boolean }
  /** ISO timestamp of the current lifetime deadline (null when not Running). */
  timeoutAt?: string | null
  onTimeout?: InstaboxOnTimeout
  autoSuspendAfterSeconds?: number
  metadata?: Record<string, string>
  /** Pending operation id, or null when the answer is already final. */
  operationId?: string | null
}

export type InstaboxOperationState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | string

export interface InstaboxOperation {
  /** Operation id, `op_...`. */
  id: string
  machineId?: string
  state: InstaboxOperationState
  error?: unknown
  machine?: InstaboxMachine
}

export interface InstaboxCreateMachineInput {
  name: string
  /** Template id. Default `universal` (Debian 13, git, gh, Node 22, Python,
   *  Go, Rust, Docker; one fixed 4 vCPU / 8 GB / 20 GB shape). */
  templateId?: string
  /** Boot from a snapshot instead of a template. Wins over `templateId`. */
  snapshotId?: string
  timeoutSeconds: number
  onTimeout: InstaboxOnTimeout
  /** 0 is requested to disable auto-suspend; the live API ignores it (window
   *  stays 1800s). 120..86400 arms it. */
  autoSuspendAfterSeconds: number
  metadata: Record<string, string>
  /** ALWAYS false: a vault would write the caller's secrets into a box that
   *  runs agent code. */
  vault: false
  guestUser?: string
  desiredState?: string
}

export interface InstaboxExecInput {
  cmd: string
  cwd?: string
  envs?: Record<string, string>
  /** Feeds the command's stdin. Max 1 MiB. */
  stdin?: string
  /** 1..600, default 60 (seconds). */
  timeoutSeconds?: number
}

export interface InstaboxExecResult {
  stdout: string
  stderr: string
  exitCode: number
  /** True when the exec hit its `timeoutSeconds` (the API still answers 200
   *  with exitCode 124). */
  timedOut: boolean
  /** True when output was clipped by the API's 1 MiB stdout/stderr cap. */
  truncated: boolean
}

export interface InstaboxPort {
  id: string
  port: number
  /** `https://{port}-{machineIdWithoutM_}.instabox.tech`: stable per
   *  (machine, port), PUBLIC with no InstaBox-side authentication. */
  url: string
  expiresAt?: string | null
}

export interface InstaboxUsage {
  limits?: { maxMachines?: number }
  [k: string]: unknown
}

/** A typed failure from the InstaBox API. The API key is never part of
 *  `message` (transport errors and JSON error bodies carry no credential). */
export class InstaboxApiError extends Error {
  readonly status: number | null
  readonly code: string
  readonly requestId?: string
  readonly retryable?: boolean
  readonly operationId?: string

  constructor(
    message: string,
    info: {
      status: number | null
      code: string
      requestId?: string
      retryable?: boolean
      operationId?: string
    },
  ) {
    super(message)
    this.name = "InstaboxApiError"
    this.status = info.status
    this.code = info.code
    this.requestId = info.requestId
    this.retryable = info.retryable
    this.operationId = info.operationId
  }
}

export interface InstaboxClientOpts {
  /** API key (`ibk_...`). Sent only as the `X-API-Key` request header. */
  apiKey: string
  /** Default `https://api.instabox.sh`. */
  apiUrl?: string
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch
  /** Delay between a failed transport attempt and the retry, ms (backoff
   *  branches on it). */
  retryDelayMs?: (attempt: number) => Promise<void>
}

const DEFAULT_API_URL = "https://api.instabox.sh"
/** Per-request fetch timeout for control-plane calls (operations long-poll on
 *  the server at `wait=25s`, so this must exceed that). */
const REQUEST_TIMEOUT_MS = 30_000
/** Long-poll window sent to the operations endpoint. */
const OPERATION_WAIT = "25s"
/** Max HTTP wait the client lets itself spend on ONE exec call: the exec can
 *  take up to 600s inside the box. A transport error is mapped, not retried
 *  (a retry could double-run a mutating command). */
const EXEC_HTTP_TIMEOUT_MS = 620_000
/** Overall cap on waiting for ONE operation to settle. */
const OPERATION_TIMEOUT_MS = 300_000
/** Base delay for transport-error backoff on the operation poll. */
const OPERATION_RETRY_BASE_DELAY_MS = 500
/** Max attempts of the create-retry loop under transport errors. */
const CREATE_RETRY_ATTEMPTS = 5

interface InstaboxErrorBody {
  error?: {
    code?: unknown
    message?: unknown
    requestId?: unknown
    retryable?: unknown
    operationId?: unknown
  }
  [k: string]: unknown
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** True by rules measured in the official CLI: HTTP 402/403/429, or a code or
 *  message mentioning "quota" or "limit", means this ACCOUNT is out of room
 *  (the limit is 5 machines, suspended and stopped ones included). */
export function isInstaboxQuotaFailure(
  status: number | null,
  code: string,
  message: string,
): boolean {
  if (status === 402 || status === 403 || status === 429) return true
  return /quota|limit/i.test(code) || /quota|limit/i.test(message)
}

/**
 * Typed InstaBox client. Transport errors on ONE-SHOT local calls are mapped
 * to an `InstaboxApiError` with `code: "transport_error"`; only the
 * operation-waiter retries (with backoff). `exec` is never auto-retried: a
 * retry could run a mutating command twice.
 */
export class InstaboxClient {
  private readonly apiKey: string
  private readonly apiUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly retryDelayMs: (attempt: number) => Promise<void>

  constructor(opts: InstaboxClientOpts) {
    this.apiKey = opts.apiKey
    this.apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "")
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.retryDelayMs =
      opts.retryDelayMs ??
      (attempt => new Promise(resolve => setTimeout(resolve, OPERATION_RETRY_BASE_DELAY_MS * attempt)))
  }

  private async request<T>(
    method: string,
    path: string,
    init: {
      body?: unknown
      idempotency?: string
      serviceTimeoutMs?: number
    } = {},
  ): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
          ...(init.idempotency ? { "Idempotency-Key": init.idempotency } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(init.serviceTimeoutMs ?? REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      throw new InstaboxApiError(`instabox: transport failure calling ${method} ${path}`, {
        status: null,
        code: "transport_error",
        retryable: true,
      })
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      const body: InstaboxErrorBody = safeParse(text)
      const code = asString(body.error?.code) ?? "http_error"
      const message = asString(body.error?.message) ?? `${method} ${path} failed with HTTP ${res.status}`
      throw new InstaboxApiError(`instabox: ${message}`, {
        status: res.status,
        code,
        requestId: asString(body.error?.requestId),
        retryable: body.error?.retryable === true || res.status === 429 || res.status >= 500,
        operationId: asString(body.error?.operationId),
      })
    }
    const raw = (await res.json()) as T
    return raw
  }

  /** POST /v1/machines. Retried on TRANSPORT errors only (idempotency key is
   *  fixed per instance call, so a retry after a lost response cannot mint a
   *  duplicate machine). Applied to the network-safe envelope, then the 202
   *  body is returned. */
  async createMachine(input: InstaboxCreateMachineInput, idempotencyKey: string): Promise<InstaboxOperation> {
    return requestWithTransportRetry(
      () => this.request<InstaboxOperation>("POST", "/v1/machines", { body: input, idempotency: idempotencyKey }),
      CREATE_RETRY_ATTEMPTS,
    )
  }

  /** GET /v1/operations/{id}?wait=25s, with an overall timeout and retryable
   *  transport-error backoff. */
  async waitForOperation(operationId: string, timeoutMs = OPERATION_TIMEOUT_MS): Promise<InstaboxOperation> {
    const deadline = Date.now() + timeoutMs
    for (let attempt = 1; ; attempt++) {
      let op: InstaboxOperation | null = null
      let transportError = false
      try {
        op = await this.request<InstaboxOperation>(
          "GET",
          `/v1/operations/${encodeURIComponent(operationId)}?wait=${OPERATION_WAIT}`,
        )
      } catch (err) {
        if (!isTransportError(err)) throw err
        transportError = true
      }
      if (op !== null) {
        if (op.state === "succeeded") return op
        if (op.state === "failed") {
          throw new InstaboxApiError(describeOperationError(op), {
            status: null,
            code: "operation_failed",
            operationId,
          })
        }
      }
      if (Date.now() >= deadline) {
        throw new InstaboxApiError(
          `instabox: operation ${operationId} did not settle within ${timeoutMs}ms.`,
          { status: null, code: "operation_timeout", operationId },
        )
      }
      if (transportError) await this.retryDelayMs(attempt)
    }
  }

  /** GET /v1/machines/{id} (accepts id or name; ports/wake/files need `id`). */
  getMachine(idOrName: string): Promise<InstaboxMachine> {
    return this.request<InstaboxMachine>("GET", `/v1/machines/${encodeURIComponent(idOrName)}`)
  }

  /** GET /v1/machines?metadata=k:v&...&limit=N. */
  async listMachines(metadata: Record<string, string>, limit?: number): Promise<InstaboxMachine[]> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(metadata)) qs.append("metadata", `${k}:${v}`)
    if (limit !== undefined) qs.set("limit", String(limit))
    const suffix = qs.size > 0 ? `?${qs.toString()}` : ""
    const raw: unknown = await this.request<unknown>("GET", `/v1/machines${suffix}`)
    if (Array.isArray(raw)) return raw as InstaboxMachine[]
    const wrapped = raw as { machines?: unknown }
    if (Array.isArray(wrapped.machines)) return wrapped.machines as InstaboxMachine[]
    return []
  }

  /** GET /v1/usage (limits.maxMachines). */
  readUsage(): Promise<InstaboxUsage> {
    return this.request<InstaboxUsage>("GET", "/v1/usage")
  }

  /** PATCH /v1/machines/{id}. Answers 200 with the updated MACHINE (measured
   *  live: `operationId` is null, there is no operation to wait on), so the
   *  machine's own `id` must never be handed to `waitForOperation`. A pending
   *  `operationId` is still awaited if the API ever returns one. */
  async patchMachine(
    id: string,
    patch: { timeoutSeconds?: number; onTimeout?: InstaboxOnTimeout } | { autoSuspendAfterSeconds: number },
    idempotencyKey?: string,
  ): Promise<InstaboxMachine> {
    const machine = await this.request<InstaboxMachine>("PATCH", `/v1/machines/${encodeURIComponent(id)}`, {
      body: patch,
      idempotency: idempotencyKey ?? crypto.randomUUID(),
    })
    if (typeof machine.operationId === "string" && machine.operationId.length > 0) {
      await this.waitForOperation(machine.operationId)
    }
    return machine
  }

  /** DELETE /v1/machines/{id}. The API rejects a DELETE without an
   *  `Idempotency-Key` (HTTP 400), so one is always sent. */
  deleteMachine(id: string): Promise<InstaboxOperation> {
    return this.request<InstaboxOperation>("DELETE", `/v1/machines/${encodeURIComponent(id)}`, {
      idempotency: crypto.randomUUID(),
    })
  }

  /** POST /v1/machines/{id}/ports {port}. 201 first, 200 if already published
   *  (both answer the same body). */
  async publishPort(id: string, port: number): Promise<InstaboxPort> {
    return await this.request<InstaboxPort>("POST", `/v1/machines/${encodeURIComponent(id)}/ports`, {
      body: { port },
      idempotency: crypto.randomUUID(),
    })
  }

  /** DELETE /v1/machines/{id}/ports/{port}. */
  deletePort(id: string, port: number): Promise<void> {
    return this.request<void>("DELETE", `/v1/machines/${encodeURIComponent(id)}/ports/${port}`)
  }

  /** POST /v1/machines/{id}/{verb} for suspend|resume|stop|start. */
  machineAction(id: string, verb: "suspend" | "resume" | "stop" | "start"): Promise<InstaboxOperation> {
    return this.request<InstaboxOperation>(
      "POST",
      `/v1/machines/${encodeURIComponent(id)}/${verb}`,
      { idempotency: crypto.randomUUID() },
    )
  }

  /** POST /v1/machines/{id}/wake: 200 DIRECT (no operation to wait on). */
  wake(id: string): Promise<unknown> {
    return this.request<unknown>(
      "POST",
      `/v1/machines/${encodeURIComponent(id)}/wake`,
      { idempotency: crypto.randomUUID() },
    )
  }

  /** POST /v1/machines/{id}/exec. NEVER retried and NEVER idempotent: a
   *  retry could double-run a mutating command. */
  exec(id: string, input: InstaboxExecInput): Promise<InstaboxExecResult> {
    return this.request<InstaboxExecResult>(
      "POST",
      `/v1/machines/${encodeURIComponent(id)}/exec`,
      { body: input, serviceTimeoutMs: EXEC_HTTP_TIMEOUT_MS },
    )
  }
}

function describeOperationError(op: InstaboxOperation): string {
  const detail = op.error
  if (typeof detail === "string" && detail.length > 0) return `instabox: operation ${op.id} failed: ${detail}`
  if (detail !== null && typeof detail === "object") {
    const code = asString((detail as Record<string, unknown>).code)
    const message = asString((detail as Record<string, unknown>).message)
    return `instabox: operation ${op.id} failed${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}`
  }
  return `instabox: operation ${op.id} failed.`
}

function safeParse(text: string): InstaboxErrorBody {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === "object") return parsed as InstaboxErrorBody
  } catch {
    // not JSON — fall through to an empty body
  }
  return {}
}

/** Transport errors (never an HTTP status answer) and 5xx. */
export function isTransientInstaboxError(err: unknown): boolean {
  if (!(err instanceof InstaboxApiError)) {
    // Unknown non-API errors (fetch rejections already wrapped above) are not
    // retried by generic call sites.
    return false
  }
  return err.code === "transport_error" || (err.status !== null && err.status >= 500)
}

function isTransportError(err: unknown): boolean {
  return err instanceof InstaboxApiError && err.code === "transport_error"
}

async function requestWithTransportRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= attempts || !isTransportError(err)) throw err
      await new Promise(resolve => setTimeout(resolve, OPERATION_RETRY_BASE_DELAY_MS * attempt))
    }
  }
}


