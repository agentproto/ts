/**
 * Standalone wiring for {@link GbrainDocKnowledgeAdapter}.
 *
 * The adapter class itself is config-driven: it consumes a plain
 * {@link GbrainDocAdapterConfig} and knows nothing about `process.env`. This
 * module is the ONE place that binds it to the ambient environment — it reads
 * the typed `GBRAIN_*` env (via {@link loadGbrainDocKnowledgeEnv}) and
 * constructs an adapter from it, exactly the role the code-brain adapter's
 * provider factories play for their backends. Hosts that already hold a config
 * (e.g. a studio guild host resolving a per-KB `configRef` + vault secrets)
 * should construct `GbrainDocKnowledgeAdapter` directly and skip this factory.
 */

import { GbrainDocKnowledgeAdapter } from "./adapter.js"
import { gbrainDocEnvToConfig, loadGbrainDocKnowledgeEnv } from "./env.js"

/**
 * Build a {@link GbrainDocKnowledgeAdapter} from the ambient `GBRAIN_*` env.
 * Throws (via {@link loadGbrainDocKnowledgeEnv}) when `GBRAIN_BEARER_TOKEN` is
 * absent. Each call returns a fresh adapter — the adapter holds no warm state
 * (stateless JSON-RPC over HTTP), so sharing an instance is a convenience, not
 * a requirement.
 */
export function createStandaloneGbrainDocAdapter(): GbrainDocKnowledgeAdapter {
  return new GbrainDocKnowledgeAdapter(
    gbrainDocEnvToConfig(loadGbrainDocKnowledgeEnv()),
  )
}
