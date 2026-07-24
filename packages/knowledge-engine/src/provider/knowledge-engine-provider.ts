import { defineDriver } from "@agentproto/driver"
import { kbQueryBuiltin } from "./bodies/kb-query.body.js"
import { kbIngestBuiltin } from "./bodies/kb-ingest.body.js"

/**
 * AIP-30 PROVIDER for the `kb_query` + `kb_ingest` TOOL contracts.
 * `kind: "builtin"` — runs in-process and dispatches to the host-injected
 * `IKnowledgeProvider` on the tool context. Mirrors code-brain's builtin
 * provider (`packages/code-brain/src/provider/code-brain-provider.ts:15`).
 *
 * This provider carries NO backend of its own — it is the pure, in-process
 * binding of the two contracts to their typed bodies. A concrete engine is
 * supplied at call time via `context.knowledgeEngine`, or served by one of
 * the `./mcp`, `./http`, `./cli` surface projections.
 */
export const knowledgeEngineProvider = defineDriver({
  id: "knowledge-engine-builtin",
  name: "Knowledge Engine (built-in)",
  description:
    "In-process dispatch of `kb_query` / `kb_ingest` to a host-injected " +
    "IKnowledgeProvider. Backend-agnostic — the provider is supplied on the " +
    "tool context, so this binding names no retrieval engine.",
  version: "0.1.0",
  kind: "builtin",
  implements: [
    { tool: "kb_query", version: "0.1.0" },
    { tool: "kb_ingest", version: "0.1.0" },
  ],
  implementations: [kbQueryBuiltin, kbIngestBuiltin],
})
