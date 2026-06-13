/**
 * `runAuthFlow` — resolve provider → discover endpoints → dispatch to engine.
 *
 * Discovery is attempted silently; callers receive the result without knowing
 * whether live or static endpoint config was used. The flow engine receives
 * `null` for `discovered` if discovery failed or was not attempted.
 */

import { FLOW_ENGINES } from "./flow-engines/index.js"
import { discoverEndpoints, DiscoveryError } from "./discover.js"
import type {
  AuthProviderHandle,
  DiscoveredEndpoints,
  FlowResult,
  FlowRunOptions,
} from "./types.js"

export interface RunFlowOptions extends FlowRunOptions {
  /** Pre-resolved endpoints (skip discovery). Pass null to force re-discovery. */
  discovered?: DiscoveredEndpoints | null
  /** Suppress debug output. Default: false. */
  quiet?: boolean
}

export async function runAuthFlow(
  provider: AuthProviderHandle,
  opts: RunFlowOptions,
): Promise<FlowResult> {
  const flowId = provider.auth.flow
  const engine = FLOW_ENGINES[flowId]
  if (!engine) {
    throw new Error(
      `runAuthFlow: unknown flow "${flowId}" — registered: ${Object.keys(FLOW_ENGINES).join(", ")}`,
    )
  }

  // Discovery: try unless caller already provided endpoints
  let discovered: DiscoveredEndpoints | null =
    opts.discovered !== undefined ? opts.discovered : null

  if (discovered === null && flowId === "service-auth") {
    try {
      discovered = await discoverEndpoints(opts.server, { signal: opts.signal })
    } catch (err) {
      if (!opts.quiet) {
        const msg =
          err instanceof DiscoveryError
            ? err.message
            : `discovery failed: ${err}`
        process.stderr.write(`[auth] ${msg} — using static config\n`)
      }
    }
  }

  return engine.run(provider, discovered, opts)
}
