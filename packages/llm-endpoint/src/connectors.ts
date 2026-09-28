/**
 * Connectors — small, declarative probes for the local/LAN inference
 * runtimes a named endpoint (`endpoints.ts`) commonly points at: LM Studio,
 * Ollama, vLLM, llama-server, plus a generic OpenAI-compatible fallback for
 * anything else. A connector answers three questions about a `baseUrl`: is
 * this runtime actually running there (`probe`), what models does it have
 * ({@link listModels}), and does it need special request handling
 * ({@link ConnectorQuirks}).
 *
 * Used by `agentproto llm endpoints add/detect/test` and `doctor`'s
 * inference-endpoints check — never by the proxy's own request routing
 * (`index.ts`). In particular, LM Studio's GGUF Qwen builds reject a
 * non-leading system message once tool defs are present; the generic fix
 * for that lives in the adapter layer (a separate PR) — `quirks` is only a
 * hook so callers can find out which connector needs it, not a duplicate of
 * that fix.
 *
 * Deliberately dependency-free and side-effect-free at import time, like
 * `endpoints.ts` and `packs.ts`.
 */

import { isRecord } from './packs.js';

export type ConnectorId = 'lmstudio' | 'ollama' | 'vllm' | 'llama-server' | 'openai-compatible';

export const CONNECTOR_IDS: readonly ConnectorId[] = ['lmstudio', 'ollama', 'vllm', 'llama-server', 'openai-compatible'];

export function isConnectorId(value: unknown): value is ConnectorId {
  return typeof value === 'string' && (CONNECTOR_IDS as readonly string[]).includes(value);
}

export type ConnectorModelState = 'loaded' | 'not-loaded' | 'unknown';

/** One model as reported by a connector's `listModels`. `loadedCtx`/`maxCtx`
 *  are omitted (not `undefined`-filled) when the runtime's API doesn't
 *  expose them — e.g. Ollama's `/api/tags`/`/api/ps` carry no context size. */
export interface ConnectorModel {
  id: string;
  loadedCtx?: number;
  maxCtx?: number;
  device?: string;
  state: ConnectorModelState;
}

export interface ConnectorQuirks {
  /** This runtime's chat template can reject a system message that isn't
   *  the first message once tool definitions are present (observed on LM
   *  Studio GGUF Qwen builds) — callers that build the outbound message
   *  array should keep a single leading system message for it. */
  requiresLeadingSystemMessage?: boolean;
}

export interface Connector {
  id: ConnectorId;
  label: string;
  /** Default local port this runtime listens on; `null` for the
   *  OpenAI-compatible fallback, which has no default port of its own and
   *  is never probed by default-port detection. */
  defaultPort: number | null;
  quirks: ConnectorQuirks;
  /** Is this runtime actually answering at `baseUrl`? Never throws — a
   *  network error, timeout, or unexpected shape resolves `false`. */
  probe(baseUrl: string, fetchImpl?: typeof fetch): Promise<boolean>;
  /** Best-effort model listing. Never throws — a failed call resolves `[]`. */
  listModels(baseUrl: string, fetchImpl?: typeof fetch): Promise<ConnectorModel[]>;
}

const PROBE_TIMEOUT_MS = 2500;

type JsonFetchResult = { ok: true; body: unknown } | { ok: false };

/** GET `url`, time-boxed, tolerating any failure. Never throws. */
async function fetchJsonSafe(url: string, fetchImpl: typeof fetch, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<JsonFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return { ok: false };
    const body: unknown = await res.json().catch(() => null);
    return { ok: true, body };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Strip a trailing `/v1` (as stored on `EndpointConfig.baseUrl`) to reach a
 *  runtime's own root, where its native (non-OpenAI-compatible) endpoints
 *  live — e.g. LM Studio's `/api/v0/models`, Ollama's `/api/tags`. A baseUrl
 *  that doesn't end in `/v1` is assumed to already be the root. */
function runtimeRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

const lmstudio: Connector = {
  id: 'lmstudio',
  label: 'LM Studio',
  defaultPort: 1234,
  quirks: { requiresLeadingSystemMessage: true },
  async probe(baseUrl, fetchImpl = fetch) {
    const result = await fetchJsonSafe(`${runtimeRoot(baseUrl)}/api/v0/models`, fetchImpl);
    return result.ok && isRecord(result.body) && Array.isArray(result.body.data);
  },
  async listModels(baseUrl, fetchImpl = fetch) {
    const result = await fetchJsonSafe(`${runtimeRoot(baseUrl)}/api/v0/models`, fetchImpl);
    if (!result.ok || !isRecord(result.body) || !Array.isArray(result.body.data)) return [];
    return result.body.data
      .filter(isRecord)
      .filter((m): m is Record<string, unknown> & { id: string } => typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        ...(typeof m.loaded_context_length === 'number' ? { loadedCtx: m.loaded_context_length } : {}),
        ...(typeof m.max_context_length === 'number' ? { maxCtx: m.max_context_length } : {}),
        state: m.state === 'loaded' ? 'loaded' : m.state === 'not-loaded' ? 'not-loaded' : 'unknown',
      }));
  },
};

const ollama: Connector = {
  id: 'ollama',
  label: 'Ollama',
  defaultPort: 11434,
  quirks: {},
  async probe(baseUrl, fetchImpl = fetch) {
    const result = await fetchJsonSafe(`${runtimeRoot(baseUrl)}/api/tags`, fetchImpl);
    return result.ok && isRecord(result.body) && Array.isArray(result.body.models);
  },
  async listModels(baseUrl, fetchImpl = fetch) {
    const root = runtimeRoot(baseUrl);
    const [tags, ps] = await Promise.all([fetchJsonSafe(`${root}/api/tags`, fetchImpl), fetchJsonSafe(`${root}/api/ps`, fetchImpl)]);
    const loadedNames = new Set<string>();
    if (ps.ok && isRecord(ps.body) && Array.isArray(ps.body.models)) {
      for (const m of ps.body.models) {
        if (isRecord(m) && typeof m.name === 'string') loadedNames.add(m.name);
      }
    }
    if (!tags.ok || !isRecord(tags.body) || !Array.isArray(tags.body.models)) return [];
    return tags.body.models
      .filter(isRecord)
      .filter((m): m is Record<string, unknown> & { name: string } => typeof m.name === 'string')
      .map((m) => ({ id: m.name, state: loadedNames.has(m.name) ? ('loaded' as const) : ('not-loaded' as const) }));
  },
};

const llamaServer: Connector = {
  id: 'llama-server',
  label: 'llama-server',
  defaultPort: 8080,
  quirks: {},
  async probe(baseUrl, fetchImpl = fetch) {
    const result = await fetchJsonSafe(`${runtimeRoot(baseUrl)}/props`, fetchImpl);
    return result.ok && isRecord(result.body) && ('default_generation_settings' in result.body || 'model_path' in result.body);
  },
  async listModels(baseUrl, fetchImpl = fetch) {
    const [props, models] = await Promise.all([
      fetchJsonSafe(`${runtimeRoot(baseUrl)}/props`, fetchImpl),
      fetchJsonSafe(`${stripTrailingSlash(baseUrl)}/models`, fetchImpl),
    ]);
    let ctx: number | undefined;
    if (props.ok && isRecord(props.body)) {
      const gen = props.body.default_generation_settings;
      if (isRecord(gen) && typeof gen.n_ctx === 'number') ctx = gen.n_ctx;
      else if (typeof props.body.n_ctx === 'number') ctx = props.body.n_ctx;
    }
    if (!models.ok || !isRecord(models.body) || !Array.isArray(models.body.data)) return [];
    return models.body.data
      .filter(isRecord)
      .filter((m): m is Record<string, unknown> & { id: string } => typeof m.id === 'string')
      .map((m) => ({ id: m.id, ...(ctx !== undefined ? { loadedCtx: ctx, maxCtx: ctx } : {}), state: 'loaded' as const }));
  },
};

const vllm: Connector = {
  id: 'vllm',
  label: 'vLLM',
  defaultPort: 8000,
  quirks: {},
  async probe(baseUrl, fetchImpl = fetch) {
    const result = await fetchJsonSafe(`${stripTrailingSlash(baseUrl)}/models`, fetchImpl);
    // vLLM speaks the same OpenAI-compatible /v1/models shape as everything
    // else here; the one distinguishing signal without a vLLM-only endpoint
    // is that its model entries carry `max_model_len` (LM Studio, Ollama, and
    // llama-server's OpenAI-compat listings never set it).
    if (!result.ok || !isRecord(result.body) || !Array.isArray(result.body.data)) return false;
    return result.body.data.some((m) => isRecord(m) && typeof m.max_model_len === 'number');
  },
  async listModels(baseUrl, fetchImpl = fetch) {
    const result = await fetchJsonSafe(`${stripTrailingSlash(baseUrl)}/models`, fetchImpl);
    if (!result.ok || !isRecord(result.body) || !Array.isArray(result.body.data)) return [];
    return result.body.data
      .filter(isRecord)
      .filter((m): m is Record<string, unknown> & { id: string } => typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        ...(typeof m.max_model_len === 'number' ? { loadedCtx: m.max_model_len, maxCtx: m.max_model_len } : {}),
        state: 'loaded' as const,
      }));
  },
};

const openaiCompatible: Connector = {
  id: 'openai-compatible',
  label: 'OpenAI-compatible',
  defaultPort: null,
  quirks: {},
  async probe(baseUrl, fetchImpl = fetch) {
    const result = await fetchJsonSafe(`${stripTrailingSlash(baseUrl)}/models`, fetchImpl);
    return result.ok && isRecord(result.body) && Array.isArray(result.body.data);
  },
  async listModels(baseUrl, fetchImpl = fetch) {
    const result = await fetchJsonSafe(`${stripTrailingSlash(baseUrl)}/models`, fetchImpl);
    if (!result.ok || !isRecord(result.body) || !Array.isArray(result.body.data)) return [];
    return result.body.data
      .filter(isRecord)
      .filter((m): m is Record<string, unknown> & { id: string } => typeof m.id === 'string')
      .map((m) => ({ id: m.id, state: 'unknown' as const }));
  },
};

export const CONNECTORS: Record<ConnectorId, Connector> = {
  lmstudio,
  ollama,
  vllm,
  'llama-server': llamaServer,
  'openai-compatible': openaiCompatible,
};

export function connectorById(id: string): Connector | undefined {
  return isConnectorId(id) ? CONNECTORS[id] : undefined;
}

/** Probed most-specific first — `openai-compatible` claims any reachable
 *  OpenAI-compat `/models`, so it must run last, as the catch-all. */
const DETECTION_ORDER: readonly ConnectorId[] = ['lmstudio', 'ollama', 'llama-server', 'vllm', 'openai-compatible'];

/** Identify which connector is serving `baseUrl`, trying the most specific
 *  probes first and falling back to the generic OpenAI-compatible one.
 *  Returns `null` only if even the fallback probe fails (nothing OpenAI-
 *  compatible is reachable there at all). */
export async function detectConnector(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<ConnectorId | null> {
  for (const id of DETECTION_ORDER) {
    if (await CONNECTORS[id].probe(baseUrl, fetchImpl)) return id;
  }
  return null;
}

/** Default local ports probed by `agentproto llm endpoints detect`, one per
 *  runtime that has a real default port (`openai-compatible` doesn't — it's
 *  only ever selected explicitly, or as the fallback identity for a
 *  positive probe at some other port/runtime). */
export const DEFAULT_LOCAL_PORTS: Readonly<Partial<Record<ConnectorId, number>>> = {
  lmstudio: 1234,
  ollama: 11434,
  'llama-server': 8080,
  vllm: 8000,
};
