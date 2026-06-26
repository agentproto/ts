/**
 * @agentproto/harness — supervisor preset (WP5).
 *
 * Spawns a `claude-code` opus orchestrator with `orchestrator: true` so it can
 * spawn + supervise its OWN sub-agents via the daemon's scoped sub-gateway.
 * Accepts a Work-Package list and renders it into an orchestration brief, and
 * adds fan-in helpers (`subtree`, `waitForAnyChild`) on top of `AgentHandle`.
 */

import type { HarnessClient } from "../client.js"
import { makeHandle } from "../handle.js"
import type {
  AgentHandle,
  OrchestratorOption,
  StartAgentArgs,
  TurnResult,
} from "../types.js"
import type { WorkPackage } from "../wp.js"
import { renderSupervisorPrompt } from "../wp.js"
export { renderSupervisorPrompt }

export interface SupervisorHarnessOptions {
  workspace?: string
  workspaceSlug?: string
  /** Model override. Default `claude-opus-4-8`. */
  model?: string
  effort?: string
  /** Scoped-orchestrator config. Default `true` (curated subset). */
  orchestrator?: OrchestratorOption
  /** Work packages to render into the orchestration brief. */
  workPackages?: WorkPackage[]
  label?: string
}

/** Supervisor handle adds fan-in helpers over the base contract. */
export interface SupervisorHandle extends AgentHandle {
  /** Snapshot this session's child subtree (→ `session_tree`). */
  subtree(): Promise<unknown>
  /** Block until ANY child session ends a turn (→ `wait_for_any`). */
  waitForAnyChild(opts?: { timeoutMs?: number }): Promise<TurnResult>
}

const DEFAULTS = {
  model: "claude-opus-4-8",
  effort: "high",
} as const

/**
 * Build the `start_agent_session` args for the supervisor preset. Exported so
 * WP5's unit test can assert `orchestrator` + the rendered WP brief.
 */
export function buildSupervisorArgs(
  opts: SupervisorHarnessOptions,
): StartAgentArgs {
  return {
    adapter: "claude-code",
    model: opts.model ?? DEFAULTS.model,
    effort: opts.effort ?? DEFAULTS.effort,
    orchestrator: opts.orchestrator ?? true,
    ...(opts.workspace ? { cwd: opts.workspace } : {}),
    ...(opts.workspaceSlug ? { workspaceSlug: opts.workspaceSlug } : {}),
    ...(opts.workPackages?.length
      ? { prompt: renderSupervisorPrompt(opts.workPackages!) }
      : {}),
    ...(opts.label ? { label: opts.label } : {}),
  }
}

/** Create a supervisor session and return its (extended) handle. */
export async function createSupervisorHarness(
  client: HarnessClient,
  opts: SupervisorHarnessOptions = {},
): Promise<SupervisorHandle> {
  const args = buildSupervisorArgs(opts)
  const desc = await client.start(args)
  const base = makeHandle(client, {
    sessionId: desc.id,
    adapter: args.adapter,
    ...(args.model ? { model: args.model } : {}),
  })
  return {
    ...base,
    async subtree(): Promise<unknown> {
      return client.sessionTree(desc.id)
    },
    async waitForAnyChild(opts?: { timeoutMs?: number }): Promise<TurnResult> {
      const data = (await client.sessionTree(desc.id)) as {
        tree?: TreeNode[]
      }
      const childIds = collectChildIds(data.tree ?? [])
      if (childIds.length === 0) {
        return {
          sessionId: desc.id,
          event: "timeout",
        }
      }
      // wait_for_any accepts max 20 session IDs — chunk & race
      const CHUNK = 20
      if (childIds.length <= CHUNK) {
        return client.waitForAny(childIds, opts)
      }
      // Build chunks using a single slice-based expression.
      const chunks = Array.from(
        { length: Math.ceil(childIds.length / CHUNK) },
        (_, i) => childIds.slice(i * CHUNK, (i + 1) * CHUNK),
      )
      // NOTE: losing waitForAny calls have no cancellation API on the MCP
      // transport layer. They will keep their daemon connections open until
      // their own timeoutMs expires. This is a known limitation — once the
      // SDK or daemon exposes an abort/cancel mechanism this can be addressed.
      return Promise.race(chunks.map((chunk) => client.waitForAny(chunk, opts)))
    },
  }
}

/** Recursively collect all child session ids from a session_tree result. */
function collectChildIds(nodes: readonly TreeNode[]): string[] {
  const ids: string[] = []
  for (const node of nodes) {
    ids.push(node.id)
    if (node.children?.length) {
      ids.push(...collectChildIds(node.children as TreeNode[]))
    }
  }
  return ids
}

interface TreeNode {
  id: string
  children?: unknown[]
}
