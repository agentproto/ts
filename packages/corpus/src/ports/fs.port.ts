/**
 * FsPort — filesystem boundary the corpus kit consumes.
 *
 * Structural interface, NOT a nominal one — any object exposing this
 * shape satisfies it. Matches the existing Guilde `WorkspaceFsLike`
 * convention (projects/guilde/packages/core/src/services/role-source/
 * workspace.ts:38-47) so cloud and local topologies share the same
 * minimal contract.
 *
 * Paths are relative to the workspace root (no leading slash). The
 * concrete implementation (MastraFilesystem in cloud, local-fs in CLI,
 * mcp-filesystem for hybrid topologies) does the resolution.
 */

export interface FsStat {
  readonly kind: "file" | "directory"
  readonly bytes?: number
  readonly modifiedAt?: Date
}

export interface FsPort {
  /** True if a file or directory exists at `path`. */
  exists(path: string): Promise<boolean>

  /** Read a file as UTF-8 text. Throws on missing path. */
  readFile(path: string): Promise<string>

  /**
   * Write a file atomically — caller assumes content is persisted on
   * resolve. Implementations are expected to write to a temp file +
   * rename so partial writes never become visible.
   */
  writeFile(path: string, content: string): Promise<void>

  /**
   * Append to a file. MUST be atomic against concurrent appends to the
   * same path — used by the event emitter for _log.md. If the file
   * does not exist, create it.
   */
  appendFile(path: string, content: string): Promise<void>

  /**
   * List immediate children of a directory. Returns names only (NOT
   * full paths). Throws if `path` is not a directory.
   */
  readdir(path: string): Promise<readonly string[]>

  /**
   * Recursive directory listing — returns workspace-relative paths of
   * every file under `path`. Skips directories starting with `.`.
   */
  walk(path: string): Promise<readonly string[]>

  /** File metadata. Returns null if the path doesn't exist. */
  stat(path: string): Promise<FsStat | null>

  /**
   * Acquire a cross-process advisory lock on `path`. Used by the
   * writer for atomic multi-file transactions (entry write + _index
   * regen + _log append). Implementations MAY no-op for single-process
   * topologies (local CLI), but cloud hosts MUST enforce real locking.
   */
  lock(path: string): Promise<FsLockHandle>
}

export interface FsLockHandle {
  release(): Promise<void>
}
