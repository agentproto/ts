/**
 * `WorkspaceFs` — minimal `readFile` / `writeFile` adapter over a
 * workspace directory. Mirrors the `McpWorkspace.filesystem` shape
 * used by `@guilde/mcp` so the daemon can be plugged in as the
 * workspace backend for a Guilde MCP server (via its
 * `loadGuildWorkspace` injection point) without re-shimming.
 *
 * All paths are workspace-relative. Absolute paths are rejected to
 * keep the surface predictable when the daemon binds to a public
 * port.
 */

import { existsSync } from "node:fs"
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path"

export interface WorkspaceFs {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string | Uint8Array): Promise<void>
  exists(path: string): Promise<boolean>
}

export interface CreateWorkspaceFsOptions {
  /** Absolute path to the workspace root. */
  workspace: string
}

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspacePathError"
  }
}

export function createWorkspaceFs(opts: CreateWorkspaceFsOptions): WorkspaceFs {
  const root = resolve(opts.workspace)

  function resolvePath(path: string): string {
    if (typeof path !== "string" || path.length === 0) {
      throw new WorkspacePathError("path must be a non-empty string")
    }
    if (isAbsolute(path)) {
      throw new WorkspacePathError(
        "absolute paths are not allowed; use a workspace-relative path",
      )
    }
    const joined = normalize(join(root, path))
    const rel = relative(root, joined)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new WorkspacePathError(
        `path escapes the workspace: '${path}'`,
      )
    }
    return joined
  }

  return {
    async readFile(path) {
      const abs = resolvePath(path)
      const buf = await fsReadFile(abs)
      return buf.toString("utf8")
    },
    async writeFile(path, content) {
      const abs = resolvePath(path)
      await mkdir(dirname(abs), { recursive: true })
      await fsWriteFile(abs, content)
    },
    async exists(path) {
      try {
        const abs = resolvePath(path)
        return existsSync(abs)
      } catch {
        return false
      }
    },
  }
}
