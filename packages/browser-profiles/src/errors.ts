import { ToolError } from "@agentproto/tool"

export const SESSION_SOURCE_UNKNOWN_CODE = "browser-profiles:unknown-source" as const
export const SESSION_SOURCE_DUPLICATE_CODE = "browser-profiles:duplicate-source" as const
export const SESSION_DESCRIPTOR_INVALID_CODE = "browser-profiles:invalid-descriptor" as const

/** Thrown when a descriptor names a session source kind nobody registered. */
export class SessionSourceUnknownError extends ToolError {
  readonly kind: string
  readonly registered: readonly string[]

  constructor(kind: string, registered: readonly string[]) {
    super({
      code: SESSION_SOURCE_UNKNOWN_CODE,
      message:
        `no session source registered for kind "${kind}"; ` +
        `registered: ${registered.length ? registered.join(", ") : "none"}. ` +
        `Register one with registry.register({ kind, materialize }) before resolving the session.`,
    })
    this.name = "SessionSourceUnknownError"
    this.kind = kind
    this.registered = registered
  }
}

/** Thrown when a session source kind is registered twice. */
export class SessionSourceDuplicateError extends ToolError {
  readonly kind: string

  constructor(kind: string) {
    super({
      code: SESSION_SOURCE_DUPLICATE_CODE,
      message: `a session source for kind "${kind}" is already registered`,
    })
    this.name = "SessionSourceDuplicateError"
    this.kind = kind
  }
}

/** Thrown when a JSON document is not a readable session descriptor. */
export class SessionDescriptorInvalidError extends ToolError {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super({
      code: SESSION_DESCRIPTOR_INVALID_CODE,
      message: `not a valid session descriptor: ${issues.join("; ")}`,
    })
    this.name = "SessionDescriptorInvalidError"
    this.issues = issues
  }
}

export function isSessionSourceUnknownError(value: unknown): value is SessionSourceUnknownError {
  return value instanceof SessionSourceUnknownError
}

export const SESSION_SOURCE_RESERVED_CODE = "browser-profiles:reserved-source" as const
export const ACCOUNT_SWITCHER_MISSING_CODE = "browser-profiles:account-switcher-missing" as const
export const CHROME_IDENTITY_CODE = "browser-profiles:chrome-identity" as const
export const SESSION_RESOLVE_CODE = "browser-profiles:resolve" as const

/** Thrown when a host tries to register a session source under a built-in strategy kind. */
export class SessionSourceReservedError extends ToolError {
  readonly kind: string

  constructor(kind: string) {
    super({
      code: SESSION_SOURCE_RESERVED_CODE,
      message: `"${kind}" is a built-in strategy kind and cannot be registered as a session source`,
    })
    this.name = "SessionSourceReservedError"
    this.kind = kind
  }
}

/** Thrown when a descriptor pins a sub-account but no `accountSwitcher` hook was provided. */
export class AccountSwitcherMissingError extends ToolError {
  constructor(platform: string) {
    super({
      code: ACCOUNT_SWITCHER_MISSING_CODE,
      message:
        `the session pins a sub-account on "${platform}" but no accountSwitcher hook was provided; ` +
        `refusing to continue, since acting as the wrong account is worse than failing`,
    })
    this.name = "AccountSwitcherMissingError"
  }
}

/** A Chrome profile could not be confirmed as the pinned, logged-in identity. */
export class ChromeIdentityError extends ToolError {
  constructor(message: string) {
    super({ code: CHROME_IDENTITY_CODE, message })
    this.name = "ChromeIdentityError"
  }
}

/** A session descriptor could not be turned into a live session. */
export class SessionResolveError extends ToolError {
  constructor(message: string, cause?: unknown) {
    super({ code: SESSION_RESOLVE_CODE, message, ...(cause !== undefined ? { cause } : {}) })
    this.name = "SessionResolveError"
  }
}
