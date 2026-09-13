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
// Standalone create-tool kept for back-compat; new code should import
// the unified verb surface (`toolVerbs.create`, `.load`, `.list`,
// `.update`, `.resolve`, `.delete`) from `./spec.js`.
export {
  createTool,
  type CreateToolOptions,
  type CreateToolResult,
} from "./create-tool.js"
export { toolSpec, toolVerbs } from "./spec.js"
export {
  parseToolManifest,
  toolFromManifest,
  toolFromManifestOnly,
  type ToolManifest,
  type ToolManifestFrontmatter,
} from "./manifest/index.js"
export {
  ToolError,
  toToolError,
  toToolResult,
  type ToolErrorCode,
  type ToolErrorPayload,
} from "./errors.js"
export {
  paginated,
  catchErrors,
  type McpTextResult,
  type PaginatedOptions,
} from "./transformers.js"
export {
  paginate,
  toolText,
  encodeCursor,
  decodeCursor,
  pageParamsShape,
  type Page,
  type PageParams,
  type PaginateOpts,
  type CursorPayload,
} from "./envelope.js"
export type {
  ToolDefinition,
  ToolHandle,
  ToolTransformer,
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
