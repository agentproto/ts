import { ToolError } from "@agentproto/tool"

export const GRANT_DOMAIN_INVALID_CODE = "browser-profiles:grant-domain-invalid" as const
export const CONSENT_REQUIRED_CODE = "browser:consent_required" as const
export const CONSENT_FLAGS_REQUIRED_CODE = "browser-profiles:consent-flags-required" as const
export const CONSENT_DECLINED_CODE = "browser-profiles:consent-declined" as const
export const SINK_ACK_REQUIRED_CODE = "browser-profiles:sink-ack-required" as const
export const AGENT_GRANT_REFUSED_CODE = "browser-profiles:agent-grant-refused" as const
export const FULL_PROFILE_REFUSED_CODE = "browser-profiles:full-profile-refused" as const
export const LEDGER_RECORD_INVALID_CODE = "browser-profiles:ledger-record-invalid" as const
export const GRANT_STORE_INVALID_CODE = "browser-profiles:grant-store-invalid" as const

export type GrantDomainReason = "empty" | "wildcard" | "leading-dot" | "bare-tld" | "public-suffix" | "invalid"

const DOMAIN_HINT: Record<GrantDomainReason, string> = {
  empty: "a grant needs at least one explicit domain",
  wildcard: "wildcards are not grantable; name each registrable domain (a grant already covers its subdomains)",
  "leading-dot": "write the domain without a leading dot",
  "bare-tld": "a bare TLD is not a registrable domain",
  "public-suffix": "a public suffix is shared by unrelated sites and cannot be granted",
  invalid: "expected a lowercase host such as github.com (ASCII or punycode, at least two labels)",
}

/** A grant's domain list broke AIP-63 C2 (wildcard, empty, bare TLD, leading dot, public suffix). */
export class GrantDomainError extends ToolError {
  readonly reason: GrantDomainReason
  readonly domain: string | undefined

  constructor(reason: GrantDomainReason, domain?: string) {
    super({
      code: GRANT_DOMAIN_INVALID_CODE,
      message: `${domain === undefined ? "domain list" : `"${domain}"`} rejected (${reason}): ${DOMAIN_HINT[reason]}`,
    })
    this.name = "GrantDomainError"
    this.reason = reason
    this.domain = domain
  }
}

/** The caller has no usable grant for this. Also what a device sees for another device's grant (C12). */
export class ConsentRequiredError extends ToolError {
  constructor(message = "no active grant covers this request") {
    super({ code: CONSENT_REQUIRED_CODE, message })
    this.name = "ConsentRequiredError"
  }
}

/** A non-interactive request lacked `--domains` plus `--yes`, or the named full-profile request (C4). */
export class NonInteractiveConsentError extends ToolError {
  readonly missing: readonly string[]

  constructor(missing: readonly string[]) {
    super({
      code: CONSENT_FLAGS_REQUIRED_CODE,
      message:
        `non-interactive import refused: pass ${missing.join(" and ")}. ` +
        `There is no default of "all domains"; name each domain and confirm with --yes.`,
    })
    this.name = "NonInteractiveConsentError"
    this.missing = missing
  }
}

/** The human declined at the prompt. */
export class ConsentDeclinedError extends ToolError {
  constructor(what: string) {
    super({ code: CONSENT_DECLINED_CODE, message: `consent declined: ${what}` })
    this.name = "ConsentDeclinedError"
  }
}

/** Material would go to a remote sink nobody acknowledged (C6). */
export class SinkAckRequiredError extends ToolError {
  readonly sinkId: string

  constructor(sinkId: string) {
    super({
      code: SINK_ACK_REQUIRED_CODE,
      message: `remote sink "${sinkId}" needs an explicit human acknowledgement (its id and operator) before any session material is sent`,
    })
    this.name = "SinkAckRequiredError"
    this.sinkId = sinkId
  }
}

/** An agent tried something only a human consent path may do (C7). */
export class AgentGrantRefusedError extends ToolError {
  readonly attempt: string

  constructor(attempt: string) {
    super({
      code: AGENT_GRANT_REFUSED_CODE,
      message:
        `refused: an agent cannot ${attempt}. Ask the user; they widen access through the operator channel, ` +
        `and only a human decision counts.`,
    })
    this.name = "AgentGrantRefusedError"
    this.attempt = attempt
  }
}

/** A full-profile grant was requested the wrong way (not by name, or with a remote sink) (C3). */
export class FullProfileGrantError extends ToolError {
  constructor(message: string) {
    super({ code: FULL_PROFILE_REFUSED_CODE, message })
    this.name = "FullProfileGrantError"
  }
}

/** A ledger row broke the AIP-63 `ledgerRecord` shape; nothing was written. */
export class LedgerRecordInvalidError extends ToolError {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super({ code: LEDGER_RECORD_INVALID_CODE, message: `invalid consent ledger record: ${issues.join("; ")}` })
    this.name = "LedgerRecordInvalidError"
    this.issues = issues
  }
}

/** The grants file is not a readable grant list. */
export class GrantStoreInvalidError extends ToolError {
  constructor(message: string) {
    super({ code: GRANT_STORE_INVALID_CODE, message })
    this.name = "GrantStoreInvalidError"
  }
}
