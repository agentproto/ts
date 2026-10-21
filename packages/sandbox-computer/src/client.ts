/**
 * Typed HTTP client for the computer controller. Nothing here depends on
 * any studio package — plain `fetch` plus the contract schemas in
 * `@agentproto/computer-api`.
 *
 * SECURITY CONTRACT: the service token is carried ONLY in the
 * `Authorization` header of outgoing requests. It is redacted from every
 * error message this client produces, and this client never logs anything.
 */

import {
  attachRequestSchema,
  capacityResponseSchema,
  computerListResponseSchema,
  computerStatusSchema,
  createComputerRequestSchema,
  createComputerResponseSchema,
  errorResponseSchema,
  execResponseSchema,
  resumeResponseSchema,
  sessionsResponseSchema,
  suspendResponseSchema,
  type CapacityResponse,
  type ComputerListEntry,
  type ComputerStatus,
  type CreateComputerResponse,
  type ExecResponse,
  type ResumeResponse,
  type SessionsResponse,
  type SuspendResponse,
} from "@agentproto/computer-api"

export interface ComputerClientConfig {
  /** Controller base URL, e.g. "https://controller.internal:7110". No trailing slash. */
  baseUrl: string
  /** Bearer service token (secret). */
  token: string
  /** Tenant owning the computers created through this client
   *  (`X-Tenant-Id` header required by every /v1 route). */
  tenantId: string
  /** Extra request headers sent on every controller call, e.g. credentials
   *  an edge proxy in front of the controller requires. Values are secrets:
   *  redacted from every error message. `Authorization`, `X-Tenant-Id` and
   *  `Content-Type` are owned by the client and cannot be overridden. */
  extraHeaders?: Record<string, string>
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

const RESERVED_HEADERS = new Set(["authorization", "x-tenant-id", "content-type"])
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/

/** Keep only well-formed extra headers: token-shaped names, single-line
 *  values, and nothing the client itself owns. */
export function sanitizeExtraHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADER_NAME_RE.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) continue
    if (typeof value !== "string" || value === "" || value.length > 4096 || /[\r\n\0]/.test(value)) continue
    out[name] = value
  }
  return out
}

/** Controller error mapped to a typed exception. The service token is
 *  redacted from the message before construction. HTTP status is preserved
 *  so callers can distinguish 404 (gone) / 409 (state conflict) / 429
 *  (capacity) / 401 (auth) without parsing strings. */
export class ComputerApiError extends Error {
  readonly status: number
  /** Controller-provided machine error string, when it returned JSON. */
  readonly code: string | undefined
  /** `Retry-After` response header, converted to milliseconds. */
  readonly retryAfterMs: number | undefined
  /** `host-capacity` error details, when the controller supplied them. */
  readonly resource: string | undefined
  readonly requested: number | undefined
  readonly available: number | undefined

  constructor(
    status: number,
    message: string,
    code?: string,
    details: { retryAfterMs?: number; resource?: string; requested?: number; available?: number } = {},
  ) {
    super(message)
    this.name = "ComputerApiError"
    this.status = status
    this.code = code
    this.retryAfterMs = details.retryAfterMs
    this.resource = details.resource
    this.requested = details.requested
    this.available = details.available
  }
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) to ms. */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

/** Remove any occurrence of `secret` from `text` (never log the token). */
export function redactSecret(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join("[redacted]")
  }
  return out
}

/** Body for `POST /v1/computers` — declared explicitly for excess-property
 *  checking at call sites (typos fail to compile) and mirrored by
 *  `createComputerRequestSchema` in `@agentproto/computer-api`, which
 *  validates the same shape on the wire in `createComputer`. */
export interface CreateComputerInput {
  template: string
  tenantId: string
  cpus?: number
  memoryMiB?: number
  rootDiskMiB?: number
  ttl?: number
  /** Concurrent sessions the computer is sized for (controller default 1). */
  maxSessions?: number
  env?: Record<string, string>
  /** Deny-by-default egress allowlist; a computer created without one has no DNS. */
  egress?: { allow: Array<{ host: string; port: number }> }
  /** Egress IP selection: `"auto"`, `"dedicated"`, or a pool slot id. Omitted
   *  for the default `"shared"` so older controllers keep working. */
  egressIp?: string
}

export class ComputerControllerClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly tenantId: string
  private readonly extraHeaders: Record<string, string>
  private readonly fetchImpl: typeof fetch

  constructor(config: ComputerClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "")
    this.token = config.token
    this.tenantId = config.tenantId
    this.extraHeaders = sanitizeExtraHeaders(config.extraHeaders)
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  private secrets(): string[] {
    return [this.token, ...Object.values(this.extraHeaders)]
  }

  private headers(): Record<string, string> {
    return {
      ...this.extraHeaders,
      Authorization: `Bearer ${this.token}`,
      "X-Tenant-Id": this.tenantId,
      "Content-Type": "application/json",
    }
  }

  /** One request → parsed JSON, or a ComputerApiError on failure. The token
   *  is redacted from every message produced here. */
  private async request<T>(
    method: string,
    path: string,
    schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
    body?: unknown,
  ): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (err) {
      throw new ComputerApiError(
        0,
        redactSecret(
          `computer controller unreachable at ${this.baseUrl} (${err instanceof Error ? err.message : String(err)})`,
          this.secrets(),
        ),
      )
    }

    const raw = await res.text().catch(() => "")
    let json: unknown = undefined
    if (raw !== "") {
      try {
        json = JSON.parse(raw)
      } catch {
        json = undefined
      }
    }

    if (!res.ok) {
      const parsedError = errorResponseSchema.safeParse(json)
      const code = parsedError.success ? redactSecret(parsedError.data.error, this.secrets()) : undefined
      const detail = parsedError.success && parsedError.data.detail !== undefined
        ? ` — ${JSON.stringify(parsedError.data.detail).slice(0, 500)}`
        : ""
      const fields = parsedError.success ? (parsedError.data as Record<string, unknown>) : undefined
      const numberField = (name: string): number | undefined => {
        const value = fields?.[name]
        return typeof value === "number" && Number.isFinite(value) ? value : undefined
      }
      throw new ComputerApiError(
        res.status,
        redactSecret(`computer controller ${res.status} on ${method} ${path}: ${code ?? res.statusText}${detail}`, this.secrets()),
        code,
        {
          retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
          resource: typeof fields?.resource === "string" ? fields.resource : undefined,
          requested: numberField("requested"),
          available: numberField("available"),
        },
      )
    }

    // 200/204 with no body: every success schema tolerates `{}` (all fields
    // optional), so an empty body parses as `{}` instead of blowing up on
    // `undefined`.
    if (res.ok && json === undefined) json = {}

    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      throw new ComputerApiError(
        res.status,
        redactSecret(
          `computer controller returned an unexpected ${res.status} body on ${method} ${path}`,
          this.secrets(),
        ),
      )
    }
    return parsed.data
  }

  /** `POST /v1/computers`. Rejects with 400 (validation / unknown template),
   *  429 (capacity), 500 (msb create failure). */
  async createComputer(input: CreateComputerInput): Promise<CreateComputerResponse> {
    // Outbound bodies are contract-checked too: a mistyped input fails
    // locally, wrapped in a redacted ComputerApiError, not as a
    // controller 400 or a raw ZodError.
    const body = createComputerRequestSchema.safeParse(input)
    if (!body.success) {
      throw new ComputerApiError(
        400,
        redactSecret(
          `computer sandbox create input rejected before it reached the controller: ${body.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
          this.secrets(),
        ),
      )
    }
    return this.request("POST", "/v1/computers", createComputerResponseSchema, body.data)
  }

  /** `GET /v1/computers` - every computer the controller holds for the
   *  calling tenant. The gc surface: a box the controller still lists (and
   *  still charges RAM for) that no live session references is an orphan. */
  async listComputers(): Promise<ComputerListEntry[]> {
    const body = await this.request("GET", "/v1/computers", computerListResponseSchema)
    return body.computers
  }

  /** `GET /v1/capacity` - the host's memory/cpu budget, what is committed
   *  and what is still available. Used to report how much room a gc pass
   *  would free back. */
  async getCapacity(): Promise<CapacityResponse> {
    return this.request("GET", "/v1/capacity", capacityResponseSchema)
  }

  /** `GET /v1/computers/:id`. `null` on 404 (never mind why) — callers map
   *  that to SandboxBoxGoneError. Any other failure throws. */
  async getComputer(id: string): Promise<ComputerStatus | null> {
    try {
      return await this.request("GET", `/v1/computers/${encodeURIComponent(id)}`, computerStatusSchema)
    } catch (err) {
      if (err instanceof ComputerApiError && err.status === 404) return null
      throw err
    }
  }

  /** `POST /v1/computers/:id/exec` — synchronous exec of an argv array.
   *  409 when the computer isn't running; 400 for validation (including
   *  "argv contains a registered secret value"). */
  async exec(id: string, argv: readonly string[], options: { timeoutSec: number }): Promise<ExecResponse> {
    return this.request(
      "POST",
      `/v1/computers/${encodeURIComponent(id)}/exec`,
      execResponseSchema,
      { argv: [...argv], timeoutSec: options.timeoutSec },
    )
  }

  /** `POST /v1/computers/:id/suspend` — full snapshot + stop. */
  async suspend(id: string): Promise<SuspendResponse> {
    return this.request("POST", `/v1/computers/${encodeURIComponent(id)}/suspend`, suspendResponseSchema)
  }

  /** `POST /v1/computers/:id/resume`. NOTE: the controller may restore into
   *  a NEW computer and answer with its id — adopt `response.id ?? id`. */
  async resume(id: string): Promise<ResumeResponse> {
    return this.request("POST", `/v1/computers/${encodeURIComponent(id)}/resume`, resumeResponseSchema)
  }

  /** `POST /v1/computers/:id/attach` — take a controller-held session slot.
   *  409 when the computer already hosts `maxSessions` sessions. An optional
   *  `holder` (stable session identity) makes a controller that tracks
   *  holders treat the attach as idempotent for that holder — a restarted
   *  daemon re-attaches onto the slot its dead predecessor still held. No
   *  holder sent: body-less legacy attach. */
  async attach(id: string, opts: { holder?: string } = {}): Promise<SessionsResponse> {
    return this.request(
      "POST",
      `/v1/computers/${encodeURIComponent(id)}/attach`,
      sessionsResponseSchema,
      this.attachBody(opts),
    )
  }

  /** `POST /v1/computers/:id/detach` — release a session slot (floors at 0).
   *  With `holder`, a controller that tracks holders releases exactly that
   *  holder's slot; without it the legacy anonymous decrement applies. */
  async detach(id: string, opts: { holder?: string } = {}): Promise<SessionsResponse> {
    return this.request(
      "POST",
      `/v1/computers/${encodeURIComponent(id)}/detach`,
      sessionsResponseSchema,
      this.attachBody(opts),
    )
  }

  /** Contract-checked attach/detach body: `{ holder }` when a holder is
   *  given, `undefined` (body-less legacy request) when not. */
  private attachBody(opts: { holder?: string }): { holder?: string } | undefined {
    if (opts.holder === undefined) return undefined
    const parsed = attachRequestSchema.safeParse({ holder: opts.holder })
    if (!parsed.success) {
      throw new ComputerApiError(
        400,
        redactSecret(
          `attach/detach holder rejected before it reached the controller: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
          this.secrets(),
        ),
      )
    }
    return parsed.data
  }

  /** `DELETE /v1/computers/:id` — rm + snapshot cleanup. 409 while sessions
   *  are attached, unless `force`. */
  async remove(id: string, options: { force?: boolean } = {}): Promise<void> {
    await this.request(
      "DELETE",
      `/v1/computers/${encodeURIComponent(id)}${options.force ? "?force=true" : ""}`,
      suspendResponseSchema,
    )
  }
}
