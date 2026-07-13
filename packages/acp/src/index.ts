/**
 * @agentproto/acp — AIP-44 ACP.md `defineAcp` reference impl + thin
 * wrappers around the upstream Agent Client Protocol SDK.
 *
 * Spec: https://agentproto.sh/docs/aip-44
 * Upstream protocol: https://agentclientprotocol.com/
 *
 * Authoring paths:
 *   - TS:  `defineAcp({...})` → `AcpHandle`
 *   - MD:  `parseAcpManifest(src) → acpFromManifest({...})` → `AcpHandle`
 *
 * Runtime paths:
 *   - Drive a subprocess agent: `createAcpClient({ output, input, ... })`
 *   - Expose an operator as a server: `createAcpServer({ handle, ... })`
 */

export const SPEC_NAME = "agentacp/v1" as const
export const SPEC_VERSION = "0.1.0-alpha" as const

export { defineAcp } from "./define-acp.js"
export {
  acpFrontmatterSchema,
  type AcpFrontmatter,
  type Aip44Extensions as Aip44ExtensionsSchema,
} from "./schema.js"
export type {
  AcpDefinition,
  AcpHandle,
  AcpRole,
  AcpTransport,
  AcpTier,
  AcpCapabilities,
  AcpAuditConfig,
  AcpMcpServer,
  AcpPermissionResolution,
  Aip44Extensions,
  StreamEvent,
} from "./types.js"
