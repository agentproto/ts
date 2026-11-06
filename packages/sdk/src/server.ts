/**
 * `@agentproto/sdk/server` - the long-running runtime gateway.
 *
 * Kept on its own subpath because `@agentproto/runtime` is a large,
 * optional peer: a tool author importing the umbrella root should never
 * have to install the daemon to define a tool.
 */

export { createGateway } from "@agentproto/runtime"
export type { CreateGatewayOptions, GatewayHandle } from "@agentproto/runtime"
