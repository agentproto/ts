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
