/**
 * Typed environment module for the corpus knowledge adapter.
 *
 * Every `process.env` read in this package flows through here — no raw
 * `process.env.X` at a call site (mirrors the code-brain + files adapters'
 * `env.ts`). Each loader parses the ambient env into a typed, defaulted config
 * once, so the rest of the adapter is a pure function of its inputs. This is
 * the ONE place the corpus-engine env names (`KNOWLEDGE_CORPUS_*`) live.
 */

/** Config for the standalone corpus backend — a local root + a workspace folder. */
export interface CorpusKnowledgeEnv {
  /**
   * Absolute host path to the workspace root the {@link LocalFs} is rooted at.
   * Default: the process cwd.
   */
  readonly root: string
  /**
   * Workspace-relative folder holding the AIP-10 corpus (KNOWLEDGE.md +
   * entries/ + sources/ + collections/). Empty string means "root IS the
   * workspace". Default `""`.
   */
  readonly workspacePath: string
}

/** Load {@link CorpusKnowledgeEnv} from `process.env` with defaults. */
export function loadCorpusKnowledgeEnv(): CorpusKnowledgeEnv {
  const root = process.env.KNOWLEDGE_CORPUS_ROOT
  const workspacePath = process.env.KNOWLEDGE_CORPUS_PATH
  return {
    root: root !== undefined && root !== "" ? root : process.cwd(),
    // Corpus workspaces are frequently rooted at the fs root (empty path),
    // unlike the files engine which defaults to a `knowledge/` subfolder.
    workspacePath:
      workspacePath !== undefined ? workspacePath.trim() : "",
  }
}
