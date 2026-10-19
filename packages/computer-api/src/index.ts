/**
 * @agentproto/computer-api - versioned public contract for the computer
 * controller's HTTP API (`/v1/computers...`). Zod schemas plus inferred
 * types for every request body, response, the error envelope, computer
 * states and published ports. Template ids are an open string.
 */

export { COMPUTER_API_VERSION } from "./version.js"

export {
  COMPUTER_STATES,
  computerStateSchema,
  COMPUTER_STATE_UNKNOWN,
} from "./computer-states.js"
export type { ComputerState } from "./computer-states.js"

export {
  portPublishSchema,
  egressRuleSchema,
  errorResponseSchema,
  createComputerRequestSchema,
  createComputerResponseSchema,
  computerStatusSchema,
  execRequestSchema,
  execResponseSchema,
  suspendResponseSchema,
  resumeResponseSchema,
  sessionsResponseSchema,
} from "./schemas.js"

export type {
  PortPublish,
  EgressRule,
  ErrorResponse,
  CreateComputerRequest,
  CreateComputerResponse,
  ComputerStatus,
  ExecRequest,
  ExecResponse,
  SuspendResponse,
  ResumeResponse,
  SessionsResponse,
} from "./schemas.js"
