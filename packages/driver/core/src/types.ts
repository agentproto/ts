import type {
  DriverKind,
  ToolContext,
  ToolHandle,
} from "@agentproto/tool"
import type { ToolImplementation } from "./implement-tool.js"

/**
 * AIP-30 DriverDefinition — what an author hands to {@link defineDriver}.
 *
 * Field set mirrors `DRIVER.md` frontmatter. Bodies live in the
 * `execute` map keyed by tool id; one provider MAY implement multiple
 * tools.
 */
export interface DriverDefinition {
  /** Machine identifier. Lowercase, digits, dashes, dots. 2–80 chars. */
  id: string
  /** Human-readable display name. */
  name: string
  /** One-paragraph purpose. */
  description: string
  /** Spec version of THIS provider (semver). */
  version?: string
  /** Concrete subtype. */
  kind: DriverKind

  /** Per-tool dispatch bindings. ≥1 entry. */
  implements: readonly ImplementsEntry[]

  /**
   * Per-tool execute bodies, keyed by `implements[].tool` id. Legacy
   * form — used for `.md`-driven dynamic loading where the contract
   * handle isn't in scope at module load time. TypeScript authors
   * SHOULD prefer {@link DriverDefinition.implementations} for
   * compile-time type safety against the contract's generics.
   *
   * `defineDriver` accepts either field; both can coexist when a
   * provider mixes typed and dynamic bodies. On the same tool id,
   * `implementations` wins (typed beats untyped).
   */
  execute?: Record<string, ExecuteFn>

  /**
   * Typed implementations bound to their contract handles via
   * {@link implementTool}(handle, body). Each carries `impl.tool.id`,
   * so the author doesn't restate the binding as a string key.
   * `defineDriver` reads `impl.tool.id` to populate the runtime
   * execute map.
   *
   * Equivalent in role to Solidity's `is IERC20` declarations on a
   * contract: the compiler enforces shape match between the body
   * and the interface it claims to implement.
   *
   * Type note: the array element generics are erased to
   * `ToolImplementation<any, any, any>` because heterogeneous
   * implementations (different contracts, different input/output
   * types) must coexist. Per-impl type safety is enforced at
   * `implementTool(handle, body)` call sites, not at the array
   * collection level. Without `any` here TS's contravariant function
   * positions reject heterogeneous arrays — see TS issue #21534.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  implementations?: readonly ToolImplementation<any, any, any>[]

  /** Universal lifecycle / policy / sandbox blocks (subset of frontmatter). */
  install?: readonly InstallMethod[]
  versionCheck?: VersionCheck
  auth?: AuthConfig
  network?: { egress?: readonly string[]; ingress?: readonly string[] }
  region?: readonly string[]
  policyTags?: readonly string[]
  costOverride?: CostOverride
  timeoutOverrideMs?: number
  retryOverride?: RetryPolicy
  healthCheck?: HealthCheckConfig

  /** Optional behavioural adapters. */
  login?: (args: LoginArgs) => Promise<LoginResult>
  refresh?: (args: RefreshArgs) => Promise<RefreshResult>
  parseOutput?: (args: ParseOutputArgs) => ParseOutputResult
  detectExpiry?: (args: DetectExpiryArgs) => boolean

  /** Bookkeeping. */
  tags?: readonly string[]
  metadata?: Record<string, unknown>
}

export interface ImplementsEntry {
  /** Workspace-relative path or registry id of a TOOL.md. */
  tool: string
  /** Contract semver range (npm-style). */
  version: string
  /** Optional: drop optional inputs/outputs the provider doesn't support. */
  schemaNarrowing?: {
    dropInputs?: readonly string[]
    dropOutputs?: readonly string[]
  }
  /**
   * Optional: rename or transform contract-input keys to provider-arg keys.
   * String value = identity/rename. Object = `{ from, transform }` calling
   * a named transformer exposed by the provider's entry.
   */
  mapping?: Record<string, MappingValue>
  /** Per-tool overrides; fall through to provider-level overrides. */
  costOverride?: CostOverride
  timeoutOverrideMs?: number
  retryOverride?: RetryPolicy
  /** Per-tool, kind-specific dispatch hints (argv / endpoint / mcp_tool_name / function_ref). */
  metadata?: Record<string, unknown>
}

export type MappingValue =
  | string
  | { from: string; transform?: string }

export type ExecuteFn = (args: ExecuteArgs) => Promise<unknown> | unknown

export interface ExecuteArgs {
  /** Validated input matching the contract's `inputSchema` (post-narrowing+mapping). */
  input: unknown
  /** Per-call context, validated against the contract's `contextSchema` when declared. */
  context: ToolContext
  /** Resolved provider state — auth, secrets, sandbox handle, region. */
  driverCtx: DriverContext
  /** Caller-set abort signal — MUST be honoured. */
  signal: AbortSignal
}

export interface DriverContext {
  /** Resolved secrets keyed by env-var name. Hosts MUST NOT log values. */
  secrets: Record<string, string>
  /** The provider's auth state at dispatch time. */
  authState: "unknown" | "unauthed" | "authed" | "expired"
  /** Free-form, namespaced (CLI runtimes stash sandbox handle, HTTP runtimes stash baseUrl, …). */
  [key: string]: unknown
}

export interface AuthConfig {
  /** Path to a SECRETS.md inventory (AIP-19). */
  ref?: string
  state?: { paths?: readonly string[]; env?: readonly string[] }
  login?: AuthLoginConfig
  refresh?: AuthRefreshConfig
  expiry?: { detect?: string }
}

export interface AuthLoginConfig {
  cmd?: string
  url?: string
  interactive?: boolean
  requiresCallbackUrl?: boolean
  completesWhen?: {
    cmd?: string
    exitCode?: number
    http?: { method: string; url: string; expectStatus: number }
  }
}

export interface AuthRefreshConfig {
  cmd?: string
  url?: string
  every?: string
}

export interface InstallMethod {
  method: string
  package?: string
  url?: string
  path?: string
  extractBin?: string
  verifySha256?: string
  global?: boolean
  user?: boolean
}

export interface VersionCheck {
  cmd: string
  parse: string
  range: string
  timeoutMs?: number
}

export interface CostOverride {
  costClass?: "trivial" | "metered" | "expensive"
  costUnitsPerCall?: number
  currency?: string
}

export interface RetryPolicy {
  maxAttempts: number
  backoff?: "fixed" | "exponential"
  initialMs?: number
}

export interface HealthCheckConfig {
  method: "ping" | "exec" | "http" | "noop"
  cmd?: string
  http?: { method: string; url: string; expectStatus: number }
  expectExit?: number
  every?: string
  timeoutMs?: number
}

export interface LoginArgs {
  context: DriverContext
  signal: AbortSignal
}

export type LoginResult =
  | { ok: true }
  | {
      ok: false
      reason: "user_cancelled" | "callback_failed" | "upstream_error"
      message?: string
    }

export interface RefreshArgs {
  context: DriverContext
  signal: AbortSignal
}

export type RefreshResult =
  | { ok: true; nextRefreshAt?: string }
  | {
      ok: false
      reason: "auth_expired" | "upstream_error"
      message?: string
    }

export interface ParseOutputArgs {
  exitCode?: number
  stdout: string | Uint8Array
  stderr: string
  expected: { format: "text" | "json" | "yaml" | "binary" }
}

export interface ParseOutputResult {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string; retryable?: boolean }
}

export interface DetectExpiryArgs {
  exitCode?: number
  httpStatus?: number
  exception?: { name: string; message: string }
  headers?: Record<string, string>
}

/**
 * Host-registrable provider handle returned by {@link defineDriver}.
 * Resolver consumes this; kind-specific runtimes wrap their dispatch
 * around the handle's `execute` map.
 */
export interface DriverHandle {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version?: string
  readonly kind: DriverKind
  readonly implements: readonly ImplementsEntry[]
  readonly install: readonly InstallMethod[]
  readonly versionCheck?: VersionCheck
  readonly auth?: AuthConfig
  readonly network: { egress: readonly string[]; ingress: readonly string[] }
  readonly region: readonly string[]
  readonly policyTags: readonly string[]
  readonly costOverride?: CostOverride
  readonly timeoutOverrideMs?: number
  readonly retryOverride?: RetryPolicy
  readonly healthCheck?: HealthCheckConfig
  readonly tags: readonly string[]
  readonly metadata: Record<string, unknown>

  /** Execute body for tool id; throws if the id isn't in `implements[]`. */
  readonly execute: Record<string, ExecuteFn>

  /** Optional behavioural adapters. */
  readonly login?: (args: LoginArgs) => Promise<LoginResult>
  readonly refresh?: (args: RefreshArgs) => Promise<RefreshResult>
  readonly parseOutput?: (args: ParseOutputArgs) => ParseOutputResult
  readonly detectExpiry?: (args: DetectExpiryArgs) => boolean
}

/**
 * Resolver decision: which provider to dispatch a contract call to.
 */
export interface ResolverInput {
  tool: ToolHandle
  /** Set of registered providers implementing this tool. */
  candidates: readonly DriverHandle[]
  /** Per-call context (workspace policy, region constraint, pinned provider, user). */
  context: ResolverContext
}

export interface ResolverContext {
  /** Workspace-level policy filter. */
  policyAllowedTags?: readonly string[]
  policyForbiddenTags?: readonly string[]
  /** Region constraint (e.g. "EU"). */
  regionConstraint?: string
  /** Caller-pinned provider id (overrides cost ranking). */
  pinnedProvider?: string
  /** User context for tier-aware routing. */
  user?: { id?: string; tier?: string }
  /** Free-form additional context. */
  [key: string]: unknown
}

export type ResolverResult =
  | {
      ok: true
      provider: DriverHandle
      implementsEntry: ImplementsEntry
    }
  | {
      ok: false
      error: {
        code:
          | "no_route"
          | "pinned_provider_unavailable"
          | "policy_violation"
          | "region_mismatch"
        message: string
        rejected?: ReadonlyArray<{
          providerId: string
          phase: number
          reason: string
        }>
      }
    }
