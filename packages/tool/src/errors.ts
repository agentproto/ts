import type { ToolResult } from "./types.js"

/**
 * AIP-14 conventional error codes. Tool-specific codes MAY use a domain
 * prefix (`"stripe:card_declined"`).
 */
export type ToolErrorCode =
  | "input_invalid"
  | "output_invalid"
  | "unauthorised"
  | "not_found"
  | "rate_limited"
  | "timeout"
  | "upstream_error"
  | "internal"
  | (string & {})

export interface ToolErrorPayload {
  code: ToolErrorCode
  message: string
  retryable?: boolean
  cause?: unknown
}

/**
 * Structured error thrown by tool bodies. Adapters wrap this into the
 * standard {@link ToolResult} envelope; bodies MUST throw it (never
 * return error objects).
 */
export class ToolError extends Error {
  readonly code: ToolErrorCode
  readonly retryable: boolean
  readonly cause: unknown

  constructor(payload: ToolErrorPayload) {
    super(payload.message)
    this.name = "ToolError"
    this.code = payload.code
    this.retryable = payload.retryable ?? false
    this.cause = payload.cause
  }

  toJSON(): ToolErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.cause !== undefined ? { cause: this.cause } : {}),
    }
  }
}

/**
 * Wrap an unknown thrown value into a {@link ToolError}. Used by adapters
 * to normalise non-ToolError throws into the standard envelope.
 */
export function toToolError(thrown: unknown): ToolError {
  if (thrown instanceof ToolError) return thrown
  if (thrown instanceof Error) {
    return new ToolError({
      code: "internal",
      message: thrown.message,
      cause: thrown,
    })
  }
  return new ToolError({
    code: "internal",
    message: String(thrown),
    cause: thrown,
  })
}

/**
 * Adapter helper: project a thrown ToolError (or any throw) into the
 * standard {@link ToolResult} envelope. Adapters MUST do this; bodies MUST NOT.
 */
export function toToolResult<T>(
  value: T | undefined,
  thrown: unknown
): ToolResult<T> {
  if (thrown !== undefined) {
    const err = toToolError(thrown)
    return { ok: false, error: err.toJSON() }
  }
  return { ok: true, value: value as T }
}
