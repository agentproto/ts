/**
 * Typed environment module for the files knowledge adapter.
 *
 * Every `process.env` read in this package flows through here — no raw
 * `process.env.X` at a call site (mirrors the code-brain adapter's `env.ts`).
 * Each loader parses the ambient env into a typed, defaulted config once, so
 * the rest of the adapter is a pure function of its inputs. This is the ONE
 * place the files-engine env names (`KNOWLEDGE_FILES_*`) live.
 */

/** Config for the standalone files backend — a local root + a folder to index. */
export interface FilesKnowledgeEnv {
  /**
   * Absolute host path to the workspace root the {@link LocalFs} is rooted at.
   * Default: the process cwd.
   */
  readonly root: string
  /**
   * Workspace-relative folder the engine walks and indexes (recursively).
   * Default `"knowledge"`.
   */
  readonly workspacePath: string
}

/** Load {@link FilesKnowledgeEnv} from `process.env` with defaults. */
export function loadFilesKnowledgeEnv(): FilesKnowledgeEnv {
  const root = process.env.KNOWLEDGE_FILES_ROOT
  const workspacePath = process.env.KNOWLEDGE_FILES_PATH
  return {
    root: root !== undefined && root !== "" ? root : process.cwd(),
    workspacePath:
      workspacePath !== undefined && workspacePath !== ""
        ? workspacePath.trim()
        : "knowledge",
  }
}
