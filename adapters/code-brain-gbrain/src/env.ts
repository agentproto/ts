/**
 * Typed environment module for the gbrain code-brain adapter.
 *
 * Every `process.env` read in this package flows through here — no raw
 * `process.env.X` at a call site. Each loader parses the ambient env into a
 * typed, defaulted config object once, so the rest of the adapter is a pure
 * function of its inputs. This is also the ONE place gbrain-flavoured env
 * names (`GBRAIN_*`) live, keeping the backend idiom confined to the adapter.
 */

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed <= 0) return fallback
  return parsed
}

/** Config for {@link GbrainLocalProvider} — talks to gbrain via `docker exec`. */
export interface GbrainLocalEnv {
  /** Container name the gbrain binary runs in. Default `gbrain-pg`. */
  readonly container: string
  /** The gbrain executable name inside the container. Default `gbrain`. */
  readonly binary: string
  /** Per-invocation timeout (ms). Default 45_000. */
  readonly timeoutMs: number
  /** Max stdout buffer (bytes). Default 8 MiB. */
  readonly maxBufferBytes: number
}

/** Config for {@link GbrainHttpProvider} — talks to gbrain over MCP/HTTP. */
export interface GbrainHttpEnv {
  /** gbrain HTTP base URL (its `/mcp` JSON-RPC endpoint is appended). */
  readonly endpoint: string
  /** Machine bearer token minted from gbrain's admin API (`GBRAIN_BEARER_TOKEN`). */
  readonly bearerToken: string
  /** Per-request timeout (ms). Default 45_000. */
  readonly timeoutMs: number
}

/** Config for the tracked `ask_codebase` MCP server. */
export interface CodeBrainMcpServerEnv {
  /** Bind host. Default `127.0.0.1` (loopback only — byte-compatible with the alias). */
  readonly host: string
  /** Bind port. Default `8831`. */
  readonly port: number
  /** Which `ICodeBrainProvider` backs the server: `local` (docker) or `http`. */
  readonly backend: "local" | "http"
}

/** Load {@link GbrainLocalEnv} from `process.env` with defaults. */
export function loadGbrainLocalEnv(): GbrainLocalEnv {
  return {
    container: process.env.GBRAIN_DOCKER_CONTAINER ?? "gbrain-pg",
    binary: process.env.GBRAIN_CLI_BIN ?? "gbrain",
    timeoutMs: parsePositiveInt(process.env.GBRAIN_EXEC_TIMEOUT_MS, 45_000),
    maxBufferBytes: parsePositiveInt(process.env.GBRAIN_MAX_BUFFER_BYTES, 8 * 1024 * 1024),
  }
}

/**
 * Load {@link GbrainHttpEnv} from `process.env`.
 *
 * Throws when `GBRAIN_BEARER_TOKEN` is absent — the HTTP backend cannot
 * authenticate without it, and failing at construction time is clearer than
 * a 401 on the first query.
 */
export function loadGbrainHttpEnv(): GbrainHttpEnv {
  const bearerToken = process.env.GBRAIN_BEARER_TOKEN
  if (bearerToken === undefined || bearerToken === "") {
    throw new Error(
      "GBRAIN_BEARER_TOKEN is required for the gbrain HTTP backend; mint one via gbrain's admin API and set it in the environment (see runtime/.env.pg.example).",
    )
  }
  return {
    endpoint: process.env.GBRAIN_HTTP_ENDPOINT ?? "http://127.0.0.1:3132",
    bearerToken,
    timeoutMs: parsePositiveInt(process.env.GBRAIN_HTTP_TIMEOUT_MS, 45_000),
  }
}

/** Load {@link CodeBrainMcpServerEnv} from `process.env` with defaults. */
export function loadCodeBrainMcpServerEnv(): CodeBrainMcpServerEnv {
  const backendRaw = process.env.CODE_BRAIN_MCP_BACKEND ?? "local"
  const backend: "local" | "http" = backendRaw === "http" ? "http" : "local"
  return {
    host: process.env.CODE_BRAIN_MCP_HOST ?? "127.0.0.1",
    port: parsePositiveInt(process.env.CODE_BRAIN_MCP_PORT ?? process.env.PORT, 8831),
    backend,
  }
}
