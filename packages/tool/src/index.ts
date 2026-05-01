/**
 * @agentproto/tool — AIP-14 TOOL.md `defineTool` reference impl.
 *
 * Vendor-neutral tool **contract** registration: an author writes
 * `defineTool({...})` and the runtime returns a `ToolHandle` carrying
 * identity, schemas, side-effect profile, approval class, and
 * provider routing hints. Bodies live on AIP-30 PROVIDER manifests;
 * invocation goes through `@agentproto/driver`.
 *
 * Spec: https://agentproto.sh/docs/aip-14
 */

export const SPEC_NAME = "agenttool/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export {
  defineTool,
  validateInput,
  validateContext,
  validateOutput,
} from "./define-tool.js"
export {
  ToolError,
  toToolError,
  toToolResult,
  type ToolErrorCode,
  type ToolErrorPayload,
} from "./errors.js"
export type {
  ToolDefinition,
  ToolHandle,
  ToolContext,
  ToolCapabilities,
  ApprovalClass,
  DriverConstraints,
  DriverKind,
  RetryPolicy,
  ToolResult,
  ValidationResult,
  ValidationFailure,
  ValidationSuccess,
} from "./types.js"
