/**
 * @agentproto/sandbox-box — ascii.dev Box `SandboxProvider` for @agentproto/sandbox.
 *
 * Isolated from `@agentproto/sandbox` so the provider-agnostic schema core
 * never pulls the `@asciidev/box-sdk` SDK — see AIP-36 (SANDBOX.md), which
 * lists e2b/modal/daytona/blaxel as day-1 provider ids.
 */

export { boxSandboxProvider } from "./provider.js"
