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
export {
  COMPUTER_STATES,
  computerStatusSchema,
  createComputerResponseSchema,
  errorResponseSchema,
  execResponseSchema,
  resumeResponseSchema,
  suspendResponseSchema,
} from "./api-types.js"
export type { ComputerState, ComputerStatus } from "./api-types.js"
