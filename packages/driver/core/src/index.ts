/**
 * @agentproto/driver — AIP-30 DRIVER.md `defineDriver`
 * reference implementation + 6-phase resolver + per-call dispatch.
 *
 * Spec: https://agentproto.sh/docs/aip-30
 */

export const SPEC_NAME = "agentdriver/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineDriver, normalizeToolId } from "./define-provider.js"
export { implementTool } from "./implement-tool.js"
export { resolveDriver } from "./resolver.js"
export { runTool, applyMapping } from "./run-tool.js"

export type {
  ToolImplementation,
  TypedExecuteFn,
} from "./implement-tool.js"

export type {
  DriverDefinition,
  DriverHandle,
  ImplementsEntry,
  MappingValue,
  ExecuteFn,
  ExecuteArgs,
  DriverContext,
  AuthConfig,
  AuthLoginConfig,
  AuthRefreshConfig,
  InstallMethod,
  VersionCheck,
  CostOverride,
  RetryPolicy,
  HealthCheckConfig,
  LoginArgs,
  LoginResult,
  RefreshArgs,
  RefreshResult,
  ParseOutputArgs,
  ParseOutputResult,
  DetectExpiryArgs,
  ResolverInput,
  ResolverContext,
  ResolverResult,
} from "./types.js"

export type { DriverAvailability } from "./resolver.js"
