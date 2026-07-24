/**
 * Typed environment module for the gbrain-doc knowledge adapter.
 *
 * Every `process.env` read in this package flows through here — no raw
 * `process.env.X` at a call site (mirrors the code-brain + files + corpus +
 * qdrant adapters' `env.ts`). The loader parses the ambient env into a typed,
 * validated config once, so the rest of the adapter is a pure function of its
 * inputs. This is the ONE place the gbrain-flavoured env names (`GBRAIN_*`)
 * live, keeping the backend idiom confined to the adapter.
 *
 * `GBRAIN_BEARER_TOKEN` is shared with `@agentproto/adapter-code-brain-gbrain`'s
 * HTTP backend by design — same gbrain server, same machine token — but the two
 * adapters never share a package edge; the token only ever meets gbrain at
 * runtime over HTTP.
 */

import type { GbrainDocAdapterConfig } from "./adapter.js"

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed <= 0) return fallback
  return parsed
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** Config for the standalone gbrain-doc backend — a gbrain HTTP endpoint + a
 *  machine bearer token. */
export interface GbrainDocKnowledgeEnv {
  /** gbrain HTTP base URL (`GBRAIN_ENDPOINT`); the `/mcp` JSON-RPC endpoint is
   *  appended. Default `"http://127.0.0.1:3132"`. */
  readonly endpoint: string
  /** Machine bearer token (`GBRAIN_BEARER_TOKEN`). Required — the `/mcp`
   *  endpoint is bearer-protected. */
  readonly bearerToken: string
  /** Per-request timeout (ms) (`GBRAIN_HTTP_TIMEOUT_MS`). Default 45_000. */
  readonly timeoutMs: number
}

/**
 * Load {@link GbrainDocKnowledgeEnv} from `process.env` with defaults.
 *
 * Throws when `GBRAIN_BEARER_TOKEN` is absent — the adapter cannot authenticate
 * to the `/mcp` endpoint without it, and failing at construction time is
 * clearer than a 401 on the first call.
 */
export function loadGbrainDocKnowledgeEnv(): GbrainDocKnowledgeEnv {
  const bearerToken = nonEmpty(process.env.GBRAIN_BEARER_TOKEN)
  if (bearerToken === undefined) {
    throw new Error(
      "GBRAIN_BEARER_TOKEN is required for the gbrain-doc knowledge adapter; mint one via gbrain's admin API (OAuth 2.1 client_credentials) and set it in the environment.",
    )
  }
  return {
    endpoint: nonEmpty(process.env.GBRAIN_ENDPOINT) ?? "http://127.0.0.1:3132",
    bearerToken,
    timeoutMs: parsePositiveInt(process.env.GBRAIN_HTTP_TIMEOUT_MS, 45_000),
  }
}

/** Project the typed env into a {@link GbrainDocAdapterConfig}. */
export function gbrainDocEnvToConfig(
  env: GbrainDocKnowledgeEnv,
): GbrainDocAdapterConfig {
  return {
    endpoint: env.endpoint,
    bearerToken: env.bearerToken,
    timeoutMs: env.timeoutMs,
  }
}
