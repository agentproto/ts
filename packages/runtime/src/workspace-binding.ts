import { findWorkspaceByPath, loadWorkspacesConfigSync } from "./workspaces-config.js"

/** Reads the workspaces config once and returns a cwd to registered-workspace-slug lookup. Never throws. */
export function createWorkspaceOfCwd(configPath?: string): (cwd: string) => string | undefined {
  let config: ReturnType<typeof loadWorkspacesConfigSync>
  try {
    config = loadWorkspacesConfigSync(configPath)
  } catch {
    return () => undefined
  }
  return cwd => {
    try {
      return findWorkspaceByPath(config, cwd)?.slug
    } catch {
      return undefined
    }
  }
}

/** Pairs already reported; bounded so a long-lived daemon cannot grow it forever. */
const PEER_UNVERIFIED_SEEN_MAX = 1_000
const peerUnverifiedSeen = new Set<string>()

/**
 * Shadow-mode report for a peer message the verified rule would refuse. One
 * line per sender/recipient pair per process, so a chatty unregistered-cwd pair
 * cannot flood the log. Returns whether a line was written.
 */
export function warnPeerUnverified(info: {
  senderId: string | undefined
  recipientId: string
  slug: string | undefined
  rule: string
}): boolean {
  const key = `${info.senderId ?? ""}>${info.recipientId}`
  if (peerUnverifiedSeen.has(key)) return false
  if (peerUnverifiedSeen.size >= PEER_UNVERIFIED_SEEN_MAX) peerUnverifiedSeen.clear()
  peerUnverifiedSeen.add(key)
  console.warn(
    `[permissions] peer-unverified sender=${info.senderId} recipient=${info.recipientId} slug=${info.slug} rule=${info.rule}`,
  )
  return true
}

/** Test seam: forget the pairs already reported. */
export function resetPeerUnverifiedWarnings(): void {
  peerUnverifiedSeen.clear()
}
