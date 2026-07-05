/**
 * Credential requirements for a connector — what the user must supply and how
 * each value reaches the runtime that needs it.
 *
 * Deliberately reuses two existing agentproto vocabularies rather than
 * inventing a third:
 *   - `SetupField` (`@agentproto/provider-kit`) — the same "field to collect"
 *     shape the tunnel-provider setup flow uses (name / description / required /
 *     sensitive). One vocabulary for every credential input across the project.
 *   - `SecretExposure` (`@agentproto/secrets`) — how a collected value is
 *     exposed to the runtime (env var / file / egress placeholder).
 */

import type { SetupField } from "@agentproto/provider-kit"
import type { SecretExposure } from "@agentproto/secrets/exposure"

/** Coarse classification of a credential — informs storage / UI affordances. */
export type ConnectorSecretKind =
  | "api_key"
  | "oauth_token"
  | "json_cred"
  | "cert"
  | "signing_key"

/** One credential a connector needs + how it is exposed to the runtime. */
export interface ConnectorCredentialRequirement {
  /** The field the user fills (reuses the tunnel-setup field vocabulary). */
  field: SetupField
  /** Coarse kind hint for storage / UI. */
  secretKind?: ConnectorSecretKind
  /** How the collected value reaches the runtime (env / file / egress).
   *  Omit when the host derives exposure from `secretKind` / context. */
  exposures?: SecretExposure[]
}
