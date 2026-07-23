/**
 * `@agentproto/code-brain/http` — AIP-31 HTTP surface projection for the
 * `ask_codebase` contract.
 *
 * A later adapter calls {@link defineCodeBrainHttpDriver} with its `baseUrl`
 * (and optional headers / endpoint) to obtain a conformant provider that
 * serves `ask_codebase` over HTTP. Projection wiring only — no backend, no
 * request is made at import time.
 */

import { defineHttpDriver, type HttpDriverDefinition } from "@agentproto/driver-http"
import type { DriverHandle } from "@agentproto/driver"
import { askCodebaseTool } from "../tools/ask-codebase.tool.js"

export interface CodeBrainHttpProjectionOptions {
  /** API base URL the backend serves `ask_codebase` on. */
  readonly baseUrl: string
  /** Headers attached to every request (templating allowed via `${secrets.X}`). */
  readonly defaultHeaders?: HttpDriverDefinition["defaultHeaders"]
  /** Endpoint path (relative to `baseUrl`) for the tool. Default `/ask_codebase`. */
  readonly endpoint?: string
  /** HTTP method. Default POST. */
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** Provider id override. Default `code-brain-http`. */
  readonly id?: string
}

/**
 * Build an AIP-31 HTTP provider for the `ask_codebase` contract. Thin sugar
 * over `defineHttpDriver` that pins `implements` to the single contract this
 * package owns.
 */
export function defineCodeBrainHttpDriver(
  options: CodeBrainHttpProjectionOptions,
): DriverHandle {
  return defineHttpDriver({
    id: options.id ?? "code-brain-http",
    name: "Code Brain (HTTP projection)",
    description:
      "AIP-31 HTTP projection of the ask_codebase contract — dispatches the " +
      "tool to an HTTP endpoint supplied by the caller.",
    version: "0.1.0",
    baseUrl: options.baseUrl,
    ...(options.defaultHeaders !== undefined
      ? { defaultHeaders: options.defaultHeaders }
      : {}),
    ...(options.method !== undefined ? { defaultMethod: options.method } : {}),
    implements: [
      {
        tool: askCodebaseTool.id,
        version: askCodebaseTool.version ?? "0.1.0",
        metadata: { http: { endpoint: options.endpoint ?? "/ask_codebase" } },
      },
    ],
  })
}
