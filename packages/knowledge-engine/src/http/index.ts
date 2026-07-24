/**
 * `@agentproto/knowledge-engine/http` — AIP-31 HTTP surface projection for
 * the `kb_query` + `kb_ingest` contracts.
 *
 * A later adapter calls {@link defineKnowledgeEngineHttpDriver} with its
 * `baseUrl` (and optional headers / endpoints) to obtain a conformant
 * provider that serves both tools over HTTP. Projection wiring only — no
 * backend, no request is made at import time. Mirrors code-brain's
 * `http/index.ts` (`packages/code-brain/src/http/index.ts`).
 */

import { defineHttpDriver, type HttpDriverDefinition } from "@agentproto/driver-http"
import type { DriverHandle } from "@agentproto/driver"
import { kbQueryTool } from "../tools/kb-query.tool.js"
import { kbIngestTool } from "../tools/kb-ingest.tool.js"

export interface KnowledgeEngineHttpProjectionOptions {
  /** API base URL the backend serves the tools on. */
  readonly baseUrl: string
  /** Headers attached to every request (templating allowed via `${secrets.X}`). */
  readonly defaultHeaders?: HttpDriverDefinition["defaultHeaders"]
  /** Endpoint path (relative to `baseUrl`) for `kb_query`. Default `/kb_query`. */
  readonly queryEndpoint?: string
  /** Endpoint path (relative to `baseUrl`) for `kb_ingest`. Default `/kb_ingest`. */
  readonly ingestEndpoint?: string
  /** HTTP method. Default POST. */
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** Provider id override. Default `knowledge-engine-http`. */
  readonly id?: string
}

/**
 * Build an AIP-31 HTTP provider for the knowledge-engine contracts. Thin
 * sugar over `defineHttpDriver` that pins `implements` to the two contracts
 * this package owns.
 */
export function defineKnowledgeEngineHttpDriver(
  options: KnowledgeEngineHttpProjectionOptions,
): DriverHandle {
  return defineHttpDriver({
    id: options.id ?? "knowledge-engine-http",
    name: "Knowledge Engine (HTTP projection)",
    description:
      "AIP-31 HTTP projection of the kb_query / kb_ingest contracts — " +
      "dispatches the tools to an HTTP endpoint supplied by the caller.",
    version: "0.1.0",
    baseUrl: options.baseUrl,
    ...(options.defaultHeaders !== undefined
      ? { defaultHeaders: options.defaultHeaders }
      : {}),
    ...(options.method !== undefined ? { defaultMethod: options.method } : {}),
    implements: [
      {
        tool: kbQueryTool.id,
        version: kbQueryTool.version ?? "0.1.0",
        metadata: { http: { endpoint: options.queryEndpoint ?? "/kb_query" } },
      },
      {
        tool: kbIngestTool.id,
        version: kbIngestTool.version ?? "0.1.0",
        metadata: { http: { endpoint: options.ingestEndpoint ?? "/kb_ingest" } },
      },
    ],
  })
}
