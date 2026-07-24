/**
 * Standalone wiring for {@link CorpusAdapterCore}.
 *
 * The adapter class itself is backing-agnostic: it consumes an injected
 * `FsPort` + a backing `IKnowledgeProvider` and knows nothing about `node:fs`
 * or `process.env`. This module is the ONE place that binds it to the local
 * filesystem — it reads the typed `KNOWLEDGE_CORPUS_*` env (via
 * {@link loadCorpusKnowledgeEnv}) and roots a {@link LocalFs} at it, exactly
 * the role the code-brain adapter's local-provider factory plays for
 * its backend. Hosts that already hold an `FsPort` (e.g. a studio guild host)
 * should construct `CorpusAdapterCore` directly and skip this factory.
 *
 * The corpus adapter is a COMPOSITION wrapper — retrieval runs on a backing
 * engine, not the corpus itself. Pass a real backing (the files adapter, or
 * an external vector store, as an `IKnowledgeProvider`) via `backing` for
 * live retrieval; omit it and the
 * factory wires a no-op {@link createEmptyBacking} that powers only the
 * workspace-direct surface (`listSources`/`getSource`/provenance hydration of
 * injected hits) + the health probe.
 */

import type { AccessCaller, AccessContext } from "@agentproto/corpus"
import type { IKnowledgeProvider } from "@agentproto/knowledge-engine"
import { CorpusAdapterCore } from "./adapter.js"
import { createEmptyBacking } from "./empty-backing.js"
import { loadCorpusKnowledgeEnv } from "./env.js"
import { LocalFs } from "./local-fs.js"

export interface CreateStandaloneCorpusAdapterOptions {
  /**
   * Backing engine that runs the actual vector/graph query. Defaults to a
   * no-op {@link createEmptyBacking} (zero hits) — supply a real
   * `IKnowledgeProvider` for live retrieval.
   */
  readonly backing?: IKnowledgeProvider
  /**
   * Absolute host path the {@link LocalFs} is rooted at. Overrides
   * `KNOWLEDGE_CORPUS_ROOT`; defaults to the env value (or process cwd).
   */
  readonly root?: string
  /**
   * Workspace-relative folder holding the AIP-10 corpus. Overrides
   * `KNOWLEDGE_CORPUS_PATH`; defaults to the env value (or `""`).
   */
  readonly workspacePath?: string
  /** Optional caller identity for access-policy enforcement. */
  readonly caller?: AccessCaller
  /** Optional workspace context (e.g. `homeGuild`) for the access policy. */
  readonly accessContext?: AccessContext
}

/**
 * Build a {@link CorpusAdapterCore} backed by the local filesystem, rooted and
 * scoped from the ambient `KNOWLEDGE_CORPUS_*` env (overridable via opts). Each
 * call returns a fresh adapter (and, unless a `backing` is supplied, a fresh
 * empty backing) — callers that want a shared warm state should hold onto the
 * instance.
 */
export function createStandaloneCorpusAdapter(
  opts: CreateStandaloneCorpusAdapterOptions = {}
): CorpusAdapterCore {
  const env = loadCorpusKnowledgeEnv()
  const root = opts.root !== undefined && opts.root !== "" ? opts.root : env.root
  const workspacePath =
    opts.workspacePath !== undefined ? opts.workspacePath : env.workspacePath
  return new CorpusAdapterCore({
    fs: new LocalFs({ root }),
    workspacePath,
    backing: opts.backing ?? createEmptyBacking(),
    caller: opts.caller,
    accessContext: opts.accessContext,
  })
}
