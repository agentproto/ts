/**
 * Standalone wiring for {@link FilesKnowledgeAdapter}.
 *
 * The adapter class itself is backing-agnostic: it consumes an injected
 * `FsPort` and knows nothing about `node:fs` or `process.env`. This module
 * is the ONE place that binds it to the local filesystem — it reads the
 * typed `KNOWLEDGE_FILES_*` env (via {@link loadFilesKnowledgeEnv}) and roots
 * a {@link LocalFs} at it, exactly the role the code-brain adapter's
 * `gbrainLocalProvider` factory plays for its backend. Hosts that already
 * hold an `FsPort` (e.g. a studio guild host) should construct
 * `FilesKnowledgeAdapter` directly and skip this factory.
 */

import { FilesKnowledgeAdapter } from "./adapter.js"
import { loadFilesKnowledgeEnv } from "./env.js"
import { LocalFs } from "./local-fs.js"

/**
 * Build a {@link FilesKnowledgeAdapter} backed by the local filesystem,
 * rooted and scoped from the ambient `KNOWLEDGE_FILES_*` env. Each call
 * returns a fresh adapter (and thus a fresh, empty BM25 cache) — callers
 * that want a shared warm index should hold onto the instance.
 */
export function createStandaloneFilesAdapter(): FilesKnowledgeAdapter {
  const env = loadFilesKnowledgeEnv()
  return new FilesKnowledgeAdapter({
    fs: new LocalFs({ root: env.root }),
    workspacePath: env.workspacePath,
  })
}
