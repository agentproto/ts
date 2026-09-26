/**
 * Named OpenAI-compatible endpoints — N local/LAN model servers (Ollama,
 * llama-server, vLLM, …) configured from a JSON file instead of one-off env
 * vars. Mirrors the field names of `openagentik/router`'s `providers[]`
 * schema (`kind`, `baseUrl`, `apiKeyEnv`, `defaultRequestFields`, `timeoutMs`)
 * so a config is portable between the two — see
 * `projects/openagentik/router/router.example.yaml` and
 * `packages/core/src/config/schema.ts` in that repo.
 *
 * Deliberately dependency-free (no zod, no fs writes) and side-effect-free at
 * import time, like packs.ts — this module is imported by both the proxy
 * (src/index.ts) and the CLI (`agentproto llm endpoints …`), which must NOT
 * pull in an HTTP server just to read/validate the config file.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve as resolvePath } from 'path';
import { isRecord } from './packs.js';

/** vLLM's OpenAI-compatible extension — see forge's identical field in the
 *  README's "Adding an OpenAI-compatible upstream provider" section. */
export interface EndpointDefaultRequestFields {
  chat_template_kwargs?: Record<string, unknown>;
}

export interface EndpointTimeoutConfig {
  /** Applied as the outbound socket timeout (time-to-first-byte). */
  firstTokenMs?: number;
}

/**
 * One configured endpoint. `kind` is carried (mirroring the router schema)
 * but only `"openai"` is meaningful here — every routable endpoint in
 * llm-endpoint speaks the OpenAI chat/completions wire shape, same as forge.
 */
export interface EndpointConfig {
  id: string;
  kind: 'openai';
  baseUrl: string;
  /** Name of the env var holding the key — never the key itself. Absent ⇒
   *  the endpoint is always keyless (a private/LAN server with no auth). */
  apiKeyEnv?: string;
  defaultRequestFields?: EndpointDefaultRequestFields;
  timeoutMs?: EndpointTimeoutConfig;
}

/** `forge` is always the implicit `FORGE_BASE_URL`/`FORGE_API_KEY` endpoint
 *  (see index.ts) — a file entry may not reuse its id. */
const RESERVED_ENDPOINT_IDS = new Set(['forge']);

export interface ParsedEndpointsResult {
  endpoints: EndpointConfig[];
  errors: string[];
}

/**
 * Validate one `endpoints[]` entry, appending `<where>.<field>`-scoped
 * messages to `errors`. Returns the rebuilt, typed config on success, else
 * null — mirrors packs.ts's validateModelRoute shape.
 */
function validateEndpointConfig(raw: unknown, where: string, errors: string[]): EndpointConfig | null {
  if (!isRecord(raw)) {
    errors.push(`${where}: expected an object, got ${raw === null ? 'null' : typeof raw}`);
    return null;
  }
  const { id, kind, baseUrl, apiKeyEnv, defaultRequestFields, timeoutMs } = raw;
  let ok = true;

  if (typeof id !== 'string' || id.length === 0) {
    errors.push(`${where}.id: required non-empty string`);
    ok = false;
  }
  if (kind !== 'openai') {
    errors.push(`${where}.kind: must be "openai" (got ${JSON.stringify(kind)})`);
    ok = false;
  }

  let validUrl = false;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    errors.push(`${where}.baseUrl: required non-empty string`);
    ok = false;
  } else {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        validUrl = true;
      } else {
        errors.push(`${where}.baseUrl: must use http:// or https:// (got "${baseUrl}")`);
        ok = false;
      }
    } catch {
      errors.push(`${where}.baseUrl: "${baseUrl}" is not a valid URL`);
      ok = false;
    }
  }

  if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== 'string' || apiKeyEnv.length === 0)) {
    errors.push(`${where}.apiKeyEnv: must be a non-empty string when present`);
    ok = false;
  }

  let builtFields: EndpointDefaultRequestFields | undefined;
  if (defaultRequestFields !== undefined) {
    if (!isRecord(defaultRequestFields)) {
      errors.push(`${where}.defaultRequestFields: must be an object when present`);
      ok = false;
    } else if (defaultRequestFields.chat_template_kwargs !== undefined && !isRecord(defaultRequestFields.chat_template_kwargs)) {
      errors.push(`${where}.defaultRequestFields.chat_template_kwargs: must be an object when present`);
      ok = false;
    } else if (isRecord(defaultRequestFields.chat_template_kwargs)) {
      builtFields = { chat_template_kwargs: defaultRequestFields.chat_template_kwargs };
    }
  }

  let builtTimeout: EndpointTimeoutConfig | undefined;
  if (timeoutMs !== undefined) {
    if (!isRecord(timeoutMs)) {
      errors.push(`${where}.timeoutMs: must be an object when present`);
      ok = false;
    } else if (
      timeoutMs.firstTokenMs !== undefined &&
      !(typeof timeoutMs.firstTokenMs === 'number' && Number.isFinite(timeoutMs.firstTokenMs) && timeoutMs.firstTokenMs > 0)
    ) {
      errors.push(`${where}.timeoutMs.firstTokenMs: must be a positive finite number when present`);
      ok = false;
    } else if (typeof timeoutMs.firstTokenMs === 'number') {
      builtTimeout = { firstTokenMs: timeoutMs.firstTokenMs };
    }
  }

  if (!ok || typeof id !== 'string' || typeof baseUrl !== 'string' || !validUrl) return null;

  const built: EndpointConfig = { id, kind: 'openai', baseUrl };
  if (typeof apiKeyEnv === 'string') built.apiKeyEnv = apiKeyEnv;
  if (builtFields) built.defaultRequestFields = builtFields;
  if (builtTimeout) built.timeoutMs = builtTimeout;
  return built;
}

/**
 * Validate the `{ endpoints: [...] }` envelope. Checks each entry's shape,
 * plus duplicate ids — including against the implicit `forge` id, which a
 * file entry may never reuse.
 */
export function parseEndpointsConfig(parsed: unknown): ParsedEndpointsResult {
  if (!isRecord(parsed) || !Array.isArray(parsed.endpoints)) {
    return { endpoints: [], errors: ['root: expected an object with an "endpoints" array'] };
  }
  const errors: string[] = [];
  const endpoints: EndpointConfig[] = [];
  const seenIds = new Set<string>(RESERVED_ENDPOINT_IDS);
  for (const [i, raw] of parsed.endpoints.entries()) {
    const built = validateEndpointConfig(raw, `endpoints[${i}]`, errors);
    if (!built) continue;
    if (seenIds.has(built.id)) {
      errors.push(
        `endpoints[${i}].id: duplicate endpoint id "${built.id}"` +
          (RESERVED_ENDPOINT_IDS.has(built.id) ? ' (reserved — "forge" is always the implicit FORGE_BASE_URL endpoint)' : ''),
      );
      continue;
    }
    seenIds.add(built.id);
    endpoints.push(built);
  }
  if (errors.length > 0) return { endpoints: [], errors };
  return { endpoints, errors: [] };
}

/** `~/.agentproto/llm-endpoints.json`, overridable via `LLM_ENDPOINT_ENDPOINTS_FILE`. */
export function resolveEndpointsFilePath(): string {
  const override = process.env.LLM_ENDPOINT_ENDPOINTS_FILE?.trim();
  if (override) return override;
  return resolvePath(homedir(), '.agentproto', 'llm-endpoints.json');
}

export interface EndpointsFileLoad extends ParsedEndpointsResult {
  path: string;
}

/**
 * Read + validate the endpoints file from disk. A missing file is NOT an
 * error (fail-soft, like packs.local.json) — it means "no named endpoints
 * configured", which is the normal case. Malformed JSON or a shape error IS
 * an error, and yields an empty endpoint list (fail closed on that file
 * rather than partially trusting it).
 */
export function readEndpointsFromDisk(path: string = resolveEndpointsFilePath()): EndpointsFileLoad {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { endpoints: [], errors: [], path };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { endpoints: [], errors: [`${path}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`], path };
  }
  const result = parseEndpointsConfig(parsed);
  return { ...result, path };
}

let _endpointsCache: EndpointConfig[] | null = null;

/** Cached, validated endpoint list — re-read from disk on first call after
 *  boot or after {@link resetConfiguredEndpointsCache}. A file-load error is
 *  logged once and treated as "no endpoints configured" (fail-soft), mirroring
 *  index.ts's getLocalPacks(). */
export function getConfiguredEndpoints(): EndpointConfig[] {
  if (_endpointsCache !== null) return _endpointsCache;
  const { endpoints, errors, path } = readEndpointsFromDisk();
  for (const e of errors) {
    console.warn(`[llm-endpoint] Skipping invalid endpoints file ${path} — ${e}`);
  }
  _endpointsCache = endpoints;
  return _endpointsCache;
}

/** Drop the cached endpoint list so the next call re-reads the file. */
export function resetConfiguredEndpointsCache(): void {
  _endpointsCache = null;
}

/** A resolved OpenAI-compatible upstream — host/port/protocol/path-prefix
 *  parsed from a base URL. Shared shape for forge, nebius, and every
 *  file-configured endpoint (see index.ts's ConfigurableProviderSpec). */
export interface ConfigurableUpstream {
  hostname: string;
  port: number;
  protocol: 'http' | 'https';
  /** URL pathname with any trailing slash stripped, e.g. "/v1" or "" for root. */
  pathPrefix: string;
}

/**
 * Parse an already-validated base URL into a routable upstream. Pure (no
 * warning side effect) — callers that need one-time-warn-on-invalid behavior
 * (forge/nebius, whose base URL comes from an env var that can go bad at any
 * time) wrap this themselves; a file-configured endpoint's baseUrl is
 * guaranteed valid by {@link parseEndpointsConfig} at load time, so this
 * never returns null for one.
 */
export function parseUpstreamUrl(value: string): ConfigurableUpstream | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const protocol: 'http' | 'https' = parsed.protocol === 'http:' ? 'http' : 'https';
  const port = parsed.port ? Number(parsed.port) : (protocol === 'https' ? 443 : 80);
  const pathPrefix = parsed.pathname.replace(/\/+$/, '');
  return { hostname: parsed.hostname, port, protocol, pathPrefix };
}
