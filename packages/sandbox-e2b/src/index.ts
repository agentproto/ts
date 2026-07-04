/**
 * @agentproto/sandbox-e2b — e2b `SandboxProvider` for @agentproto/sandbox.
 *
 * Isolated from `@agentproto/sandbox` so the provider-agnostic schema core
 * never pulls the `e2b` SDK — see AIP-36 (SANDBOX.md), which lists
 * e2b/modal/daytona/blaxel as day-1 provider ids.
 */

export { e2bSandboxProvider, DEFAULT_TEMPLATE } from "./provider.js"
