import { ToolError } from "@agentproto/tool"
import {
  hasCapability,
  type BrowserCapabilities,
  type BrowserCapabilityName,
} from "./capabilities.js"

/** Stable AIP-14 error code for a call that needs a capability the provider lacks. */
export const BROWSER_UNSUPPORTED_CODE = "browser:unsupported" as const

export interface BrowserUnsupportedCause {
  capability: BrowserCapabilityName
  providerId?: string
  tool?: string
}

/**
 * Thrown when a browser call needs a capability the provider does not have.
 * It is an AIP-14 `ToolError`, so `toToolResult` turns it into the standard
 * envelope: `code` is stable, `message` names the capability, and
 * `cause.capability` carries it for programmatic handling.
 */
export class BrowserUnsupportedError extends ToolError {
  readonly capability: BrowserCapabilityName
  readonly providerId: string | undefined
  readonly tool: string | undefined

  constructor(cause: BrowserUnsupportedCause) {
    const subject = cause.tool ? `"${cause.tool}"` : "this call"
    const where = cause.providerId ? ` on provider "${cause.providerId}"` : ""
    super({
      code: BROWSER_UNSUPPORTED_CODE,
      message: `${subject} needs the "${cause.capability}" capability, which is not supported${where}`,
      cause,
    })
    this.name = "BrowserUnsupportedError"
    this.capability = cause.capability
    this.providerId = cause.providerId
    this.tool = cause.tool
  }
}

export function isBrowserUnsupportedError(
  value: unknown,
): value is BrowserUnsupportedError {
  return value instanceof BrowserUnsupportedError
}

/** Throw {@link BrowserUnsupportedError} unless `capabilities` has the flag. */
export function assertCapability(
  capabilities: Partial<BrowserCapabilities>,
  name: BrowserCapabilityName,
  context: { providerId?: string; tool?: string } = {},
): void {
  if (!hasCapability(capabilities, name)) {
    throw new BrowserUnsupportedError({ capability: name, ...context })
  }
}

/**
 * Capability gate per browser tool id (AIP-63 section 2). A tool absent
 * from this table needs no capability beyond what every provider has.
 */
export const BROWSER_TOOL_GATES: Readonly<
  Record<string, BrowserCapabilityName>
> = Object.freeze({
  "browser.list_requests": "cdp",
  "browser.get_request_body": "cdp",
  "browser.cdp_send": "cdp",
  "browser.download": "downloads",
  "browser.act": "canAiActions",
})

/** Gate a tool by its id; no-op for tools without a gate. */
export function assertToolSupported(
  capabilities: Partial<BrowserCapabilities>,
  tool: string,
  providerId?: string,
): void {
  const gate = BROWSER_TOOL_GATES[tool]
  if (gate) assertCapability(capabilities, gate, { tool, ...(providerId ? { providerId } : {}) })
}
