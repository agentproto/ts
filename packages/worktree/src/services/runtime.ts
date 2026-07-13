import { loadConfigFromBase, listServices, type AgentprotoConfig } from "../config.js"
import type { WorktreeEnvContext } from "../env.js"
import { ServiceSupervisor } from "./supervisor.js"
import { ProxyTable } from "./proxy-table.js"
import { repoLabel, detectDefaultBranch } from "./context.js"

/**
 * Process-wide service state shared by the AIP-14 service tools. Independent
 * `run-script` / `start-service` / `stop-service` / `list-services` calls all
 * route through one supervisor per worktree and one proxy routing table, the
 * same way a daemon holds tunnel state in memory across requests.
 */
const supervisors = new Map<string, ServiceSupervisor>()

/** The shared reverse-proxy routing table (hostname → service port). */
export const sharedProxyTable = new ProxyTable()

/** Default reverse-proxy port when a caller doesn't pin one. */
export const DEFAULT_PROXY_PORT = 18780

export interface ResolveSupervisorInput {
  repoRoot: string
  worktreePath: string
  branch: string
  base?: string
  proxyPort?: number
}

/** The context the service tools resolve before touching the supervisor. */
export interface ResolvedWorktreeRuntime {
  supervisor: ServiceSupervisor
  config: AgentprotoConfig
}

/**
 * Resolve (creating on first use) the supervisor for a worktree: read the
 * committed `agentproto.json` from `base`, build service runtimes with
 * allocated ports, and cache it keyed by worktree path.
 */
export async function resolveSupervisor(
  input: ResolveSupervisorInput,
): Promise<ResolvedWorktreeRuntime> {
  const config = (await loadConfigFromBase(input.repoRoot, input.base)) ?? {}
  const existing = supervisors.get(input.worktreePath)
  if (existing) return { supervisor: existing, config }

  const ctx: WorktreeEnvContext = {
    sourceCheckoutPath: input.repoRoot,
    worktreePath: input.worktreePath,
    branchName: input.branch,
  }
  const defaultBranch = await detectDefaultBranch(input.repoRoot)
  const supervisor = await ServiceSupervisor.create({
    ctx,
    services: listServices(config),
    repo: repoLabel(input.repoRoot),
    isDefaultBranch: input.branch === defaultBranch,
    proxyPort: input.proxyPort ?? DEFAULT_PROXY_PORT,
    proxyTable: sharedProxyTable,
  })
  supervisors.set(input.worktreePath, supervisor)
  return { supervisor, config }
}

/** The cached supervisor for a worktree, if one has been resolved. */
export function getSupervisor(worktreePath: string): ServiceSupervisor | undefined {
  return supervisors.get(worktreePath)
}

/** Stop all services for a worktree and drop its supervisor (used by cleanup). */
export async function disposeSupervisor(worktreePath: string): Promise<void> {
  const supervisor = supervisors.get(worktreePath)
  if (!supervisor) return
  await supervisor.stopAll()
  supervisors.delete(worktreePath)
}
