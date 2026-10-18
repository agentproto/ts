/**
 * Typed HTTP client for the computer controller. Nothing here depends on
 * any studio package — plain `fetch` plus the zod mirrors in
 * `api-types.ts`.
 *
 * SECURITY CONTRACT: the service token is carried ONLY in the
 * `Authorization` header of outgoing requests. It is redacted from every
 * error message this client produces, and this client never logs anything.
 */

import {
  computerStatusSchema,
  createComputerResponseSchema,
  errorResponseSchema,
  execResponseSchema,
  resumeResponseSchema,
  suspendResponseSchema,
  type ComputerStatus,
  type CreateComputerResponse,
  type ExecResponse,
  type ResumeResponse,
  type SuspendResponse,
} from "./api-types.js"

export interface ComputerClientConfig {
  /** Controller base URL, e.g. "https://controller.internal:7110". No trailing slash. */
  baseUrl: string
  /** Bearer service token (secret). */
  token: string
  /** Tenant owning the computers created through this client
   *  (`X-Tenant-Id` header required by every /v1 route). */
  tenantId: string
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

/** Controller error mapped to a typed exception. The service token is
 *  redacted from the message before construction. HTTP status is preserved
 *  so callers can distinguish 404 (gone) / 409 (state conflict) / 429
 *  (capacity) / 401 (auth) without parsing strings. */
export class ComputerApiError extends Error {
  readonly status: number
  /** Controller-provided machine error string, when it returned JSON. */
  readonly code: string | undefined

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = "ComputerApiError"
    this.status = status
    this.code = code
  }
}

/** Remove any occurrence of `secret` from `text` (never log the token). */
export function redactSecret(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join("[redacted]")
  }
  return out
}

/** Body for `POST /v1/computers` — a strict subset of the controller's
 *  create schema (this adapter always passes tenantId explicitly). */
export interface CreateComputerInput {
  template: string
  tenantId: string
  cpus?: number
  memoryMiB?: number
  rootDiskMiB?: number
  ttl?: number
  env?: Record<string, string>
}

export class ComputerControllerClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly tenantId: string
  private readonly fetchImpl: typeof fetch

  constructor(config: ComputerClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "")
    this.token = config.token
    this.tenantId = config.tenantId
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  private secrets(): string[] {
    return [this.token]
  }

  private headers(): Record<string, string> {
    return {
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
      throw new ComputerApiError(
        res.status,
        redactSecret(`computer controller ${res.status} on ${method} ${path}: ${code ?? res.statusText}${detail}`, this.secrets()),
        code,
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
    return this.request("POST", "/v1/computers", createComputerResponseSchema, input)
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

  /** `DELETE /v1/computers/:id` — rm + snapshot cleanup. */
  async remove(id: string): Promise<void> {
    await this.request("DELETE", `/v1/computers/${encodeURIComponent(id)}`, suspendResponseSchema)
  }
}
