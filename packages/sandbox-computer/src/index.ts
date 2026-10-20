/**
 * @agentproto/sandbox-computer — self-hosted microVM "computer"
 * `SandboxProvider` for @agentproto/sandbox.
 *
 * Isolated from `@agentproto/sandbox` so the provider-agnostic schema core
 * never gains a dependency on this adapter's HTTP client — see AIP-36,
 * which lists e2b/modal/daytona/blaxel as day-1 provider ids (this one is a
 * host-registered addition).
 */

export { computerSandboxProvider, DEFAULT_PORT, DEFAULT_TEMPLATE, DEFAULT_TENANT_ID } from "./provider.js"
export { boxUrl, buildHealthCommand, buildServeCommand, buildWaitHealthyCommand, bashArgv, resolveAlias, shQuote } from "./provider.js"
export { ComputerApiError, ComputerControllerClient, redactSecret } from "./client.js"
export type { ComputerClientConfig, CreateComputerInput } from "./client.js"
export { ComputerSandboxError, isComputerSandboxError } from "./errors.js"
export type { ComputerSandboxErrorCode, ComputerSandboxErrorDetails } from "./errors.js"

/**
 * Re-exported from `@agentproto/computer-api`, the versioned public
 * contract for the controller's HTTP API (see that package's README for
 * design rules and fixtures).
 */
export {
  COMPUTER_API_VERSION,
  COMPUTER_STATES,
  computerStateSchema,
  computerStatusSchema,
  createComputerRequestSchema,
  createComputerResponseSchema,
  errorResponseSchema,
  execRequestSchema,
  execResponseSchema,
  resumeResponseSchema,
  suspendResponseSchema,
  portPublishSchema,
} from "@agentproto/computer-api"
export type {
  ComputerState,
  ComputerStatus,
  PortPublish,
  CreateComputerRequest,
  CreateComputerResponse,
  ErrorResponse,
  ExecRequest,
  ExecResponse,
  ResumeResponse,
  SuspendResponse,
} from "@agentproto/computer-api"