/**
 * WorkspaceSync — the imperative counterpart to the AIP-35 `sync`
 * policy block (the `pull` / `commit` / `push` sub-blocks). A provider
 * that backs a workspace with a remote origin (git repo, bucket)
 * implements this to seed a local working tree FROM the origin (`pull`)
 * and materialise local writes BACK to it (`push`).
 *
 * This is `sync.mode: "pull-push"` made concrete: the local filesystem
 * stays the runtime truth (fast, offline-capable, the "filesystem on
 * sait jamais" safety), while the remote repo is the durable, visible,
 * versioned origin. Contrast `sync.mode: "canonical"`, where the
 * provider's MastraFilesystem IS the live backing and every read/write
 * hits the remote per-file — that mode needs no WorkspaceSync.
 *
 * Both consumers share one contract:
 *   - a cloud workstation seeds its sandbox on spawn, pushes on close
 *   - a corpus seeds its workspace on resolve, pushes on promote
 *
 * Spec: https://agentproto.sh/docs/aip-35 (sync block) + AIP-37 (hooks)
 */

/**
 * The minimal tree surface `pull` / `push` operate on. A structural
 * subset of `FsPort` (@agentproto/corpus) — declared here so
 * `@agentproto/storage` stays dependency-free; any `FsPort` or
 * `MastraFilesystem` adapter satisfies it by shape. Paths are
 * workspace-relative (no leading slash); `""` / `.` is the root.
 */
export interface SyncTree {
  exists(path: string): Promise<boolean>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  /** Recursive listing — workspace-relative paths of every file under
   *  `path`. Skips dot-directories (matches FsPort.walk). */
  walk(path: string): Promise<readonly string[]>
}

export interface PullResult {
  /** False when the tree was already populated and `force` was unset. */
  seeded: boolean
  files: number
  bytes: number
  message: string
}

export type PushResult =
  | {
      kind: "pushed"
      /** The ref the commit landed on (branch name). */
      ref: string
      commit?: string
      prUrl?: string
      prNumber?: number
      files: number
      message: string
    }
  /** Working tree matches the origin — nothing to push. */
  | { kind: "no_changes"; message: string }
  /** No credential resolved for the origin — refuse rather than fall
   *  back to a host token (would cross-tenant commits). */
  | { kind: "no_credentials"; message: string }
  /** Credential reads the origin but cannot write to it. */
  | { kind: "no_permission"; message: string }
  | { kind: "failed"; message: string }

export interface PushOptions {
  /** Short label for the commit / branch (e.g. operator or run id). */
  label?: string
  /** Human summary woven into the commit message / PR body. */
  summary?: string
}

/**
 * Pull-push lifecycle for a remote-backed workspace. Providers expose
 * this alongside their `MastraFilesystem`; callers feature-detect it
 * (`if ("pull" in fs)`) — no parallel registry, the provider id is the
 * single dispatch key.
 */
export interface WorkspaceSync {
  /**
   * Seed `tree` from the remote origin. Idempotent. Refuses to clobber
   * a non-empty tree unless `opts.force` — a fresh workspace starts
   * empty, but a misrouted call against a warm tree must not silently
   * overwrite ongoing work.
   */
  pull(tree: SyncTree, opts?: { force?: boolean }): Promise<PullResult>

  /**
   * Materialise the current `tree` state to the origin as a single
   * commit (plus a PR when the provider's `sync.push.prPolicy` calls
   * for one). A no-op when the tree matches the origin.
   */
  push(tree: SyncTree, opts?: PushOptions): Promise<PushResult>
}

/** Feature-detect the sync capability on a resolved filesystem. */
export function hasWorkspaceSync(fs: unknown): fs is WorkspaceSync {
  return (
    typeof fs === "object" &&
    fs !== null &&
    typeof (fs as WorkspaceSync).pull === "function" &&
    typeof (fs as WorkspaceSync).push === "function"
  )
}
