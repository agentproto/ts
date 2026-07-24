/**
 * Standalone wiring for {@link QdrantKnowledgeAdapter}.
 *
 * The adapter class itself is config-driven: it consumes a plain
 * {@link QdrantAdapterConfig} and knows nothing about `process.env`. This
 * module is the ONE place that binds it to the ambient environment — it reads
 * the typed `QDRANT_*` / `OPENAI_*` env (via {@link loadQdrantKnowledgeEnv})
 * and constructs an adapter from it, exactly the role the code-brain adapter's
 * provider factories play for their backends. Hosts that already hold a config
 * (e.g. a studio guild host resolving a per-KB `configRef` + vault secrets)
 * should construct `QdrantKnowledgeAdapter` directly and skip this factory.
 */

import { QdrantKnowledgeAdapter } from "./adapter.js"
import { loadQdrantKnowledgeEnv, qdrantEnvToConfig } from "./env.js"

/**
 * Build a {@link QdrantKnowledgeAdapter} from the ambient `QDRANT_*` /
 * `OPENAI_*` env. Throws (via {@link loadQdrantKnowledgeEnv}) when `QDRANT_URL`
 * or `OPENAI_API_KEY` is absent. Each call returns a fresh adapter — the
 * adapter holds no warm state (REST + fetch), so sharing an instance is a
 * convenience, not a requirement.
 */
export function createStandaloneQdrantAdapter(): QdrantKnowledgeAdapter {
  return new QdrantKnowledgeAdapter(qdrantEnvToConfig(loadQdrantKnowledgeEnv()))
}
