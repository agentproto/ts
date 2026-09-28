/**
 * pi wiring — generate/update the matching provider entries in
 * `~/.pi/agent/models.json` (the `pi` harness's own model registry) from the
 * configured named endpoints + their connectors, so a locally loaded model
 * is usable from `pi` without a hand edit.
 *
 * Lives in `@agentproto/llm-endpoint` (not `@agentproto/cli`, where it
 * started) so BOTH the CLI (`agentproto llm endpoints sync-pi`) and the
 * daemon (`packages/runtime`'s `inference` session-binding, which must
 * sync before spawning a `pi` session against a local endpoint) can call it
 * directly — `packages/runtime` never depends on `@agentproto/cli`.
 *
 * Two rules drive the shape of this: `contextWindow` must be the model's
 * LOADED context (what's actually usable right now), never its max — a
 * stale max value is what caused `~/.pi/agent/models.json` to drift out of
 * sync by hand in practice; and this must never clobber a user's own
 * hand-added provider/model entries. One connector (Ollama) never reports a
 * loaded context size at all — `DEFAULT_CONTEXT_FALLBACK` below covers that
 * gap with a conservative guess rather than treating a genuinely loaded
 * model as nothing-to-sync. Ownership of what THIS module wrote is
 * tracked in a side ledger (`~/.agentproto/pi-models-managed.json`), never
 * inferred from `models.json`'s own content — that keeps "is this ours" a
 * recorded fact instead of a guess, and means no extra marker field has to
 * ride along in a file `pi` itself parses.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { connectorById, type ConnectorId } from './connectors.js';
import { getConfiguredEndpoints, type EndpointConfig } from './endpoints.js';

const DEFAULT_MAX_TOKENS = 8192;

/** Ollama's `/api/tags`/`/api/ps` never report a loaded model's context size
 *  (unlike LM Studio/llama-server/vLLM, which all expose it) — so a genuinely
 *  loaded Ollama model has no real `loadedCtx` to report. Rather than treat
 *  that as "nothing loaded" and silently skip it (the prior behavior), fall
 *  back to this conservative default so the model still gets synced — it is
 *  a guess, not a measurement, and callers who need the real figure should
 *  check the runtime directly (e.g. `ollama show <model>`). */
const DEFAULT_CONTEXT_FALLBACK = 4096;

export interface PiModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface PiProvider {
  baseUrl: string;
  api: string;
  apiKey: string;
  models: PiModelEntry[];
}

interface PiModelsFile {
  providers: Record<string, PiProvider>;
}

interface PiLedger {
  /** providerId -> model ids this module wrote there last run. */
  managed: Record<string, string[]>;
}

export function resolvePiModelsFilePath(): string {
  const override = process.env.AGENTPROTO_PI_MODELS_FILE?.trim();
  if (override) return override;
  return join(homedir(), '.pi', 'agent', 'models.json');
}

export function resolvePiLedgerFilePath(): string {
  const override = process.env.AGENTPROTO_PI_LEDGER_FILE?.trim();
  if (override) return override;
  return join(homedir(), '.agentproto', 'pi-models-managed.json');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function readPiModelsFile(path: string): Promise<PiModelsFile> {
  const parsed = await readJsonFile<unknown>(path, { providers: {} });
  if (!isRecord(parsed) || !isRecord(parsed.providers)) return { providers: {} };
  const providers: Record<string, PiProvider> = {};
  for (const [id, raw] of Object.entries(parsed.providers)) {
    if (!isRecord(raw) || typeof raw.baseUrl !== 'string' || typeof raw.api !== 'string' || typeof raw.apiKey !== 'string') continue;
    providers[id] = { baseUrl: raw.baseUrl, api: raw.api, apiKey: raw.apiKey, models: Array.isArray(raw.models) ? (raw.models as PiModelEntry[]) : [] };
  }
  return { providers };
}

async function readLedger(path: string): Promise<PiLedger> {
  const parsed = await readJsonFile<unknown>(path, { managed: {} });
  if (!isRecord(parsed) || !isRecord(parsed.managed)) return { managed: {} };
  const managed: Record<string, string[]> = {};
  for (const [id, ids] of Object.entries(parsed.managed)) {
    if (Array.isArray(ids)) managed[id] = ids.filter((x): x is string => typeof x === 'string');
  }
  return { managed };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A keyless endpoint still needs a non-empty `apiKey` string for pi's
 *  schema — a placeholder, never a fabricated secret. A keyed endpoint's
 *  real value is required here (pi calls the endpoint directly, not through
 *  our proxy) — never written to OUR OWN endpoints file, only to pi's. */
function resolveApiKeyValue(endpoint: EndpointConfig): string {
  if (endpoint.apiKeyEnv) {
    const value = process.env[endpoint.apiKeyEnv];
    if (value) return value;
  }
  return 'not-needed';
}

async function buildDesiredModels(endpoint: EndpointConfig, fetchImpl: typeof fetch): Promise<PiModelEntry[]> {
  const connectorId: ConnectorId = endpoint.connector ?? 'openai-compatible';
  const connector = connectorById(connectorId);
  if (!connector) return [];
  const models = await connector.listModels(endpoint.baseUrl, fetchImpl);
  return models
    .filter((m) => m.state === 'loaded')
    .map((m) => ({
      id: m.id,
      name: `${m.id} (${connector.label})`,
      reasoning: false,
      input: ['text'],
      // `loadedCtx` is only absent for a connector (Ollama) whose API never
      // reports it — see DEFAULT_CONTEXT_FALLBACK above.
      contextWindow: typeof m.loadedCtx === 'number' ? m.loadedCtx : DEFAULT_CONTEXT_FALLBACK,
      maxTokens: DEFAULT_MAX_TOKENS,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
}

export interface PiSyncEntry {
  providerId: string;
  baseUrl: string;
  action: 'added' | 'updated' | 'unchanged' | 'skipped-no-loaded-models';
  modelIds: string[];
}

export interface PiSyncResult {
  modelsPath: string;
  ledgerPath: string;
  entries: PiSyncEntry[];
}

export interface PiSyncOptions {
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Regenerate every configured named endpoint's provider entry in pi's
 * `models.json` from its connector's LIVE loaded models. Never touches a
 * provider id with no configured endpoint (nothing to regenerate it from),
 * and within a touched provider, only ever adds/updates/removes the model
 * ids THIS module previously wrote (per the ledger) — any other model in
 * that same provider (hand-added by the user) is left exactly as-is.
 */
export async function syncPiModels(opts: PiSyncOptions = {}): Promise<PiSyncResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const modelsPath = resolvePiModelsFilePath();
  const ledgerPath = resolvePiLedgerFilePath();

  const endpoints = getConfiguredEndpoints();
  const piFile = await readPiModelsFile(modelsPath);
  const ledger = await readLedger(ledgerPath);

  const entries: PiSyncEntry[] = [];
  const nextManaged: Record<string, string[]> = { ...ledger.managed };

  for (const endpoint of endpoints) {
    const desired = await buildDesiredModels(endpoint, fetchImpl);
    const previouslyManaged = new Set(ledger.managed[endpoint.id] ?? []);
    const existingProvider = piFile.providers[endpoint.id];
    const keptUserModels = (existingProvider?.models ?? []).filter((m) => !previouslyManaged.has(m.id));

    if (desired.length === 0 && !existingProvider) {
      entries.push({ providerId: endpoint.id, baseUrl: endpoint.baseUrl, action: 'skipped-no-loaded-models', modelIds: [] });
      continue;
    }

    const newModels = [...keptUserModels, ...desired];
    const unchanged =
      existingProvider !== undefined &&
      existingProvider.baseUrl === endpoint.baseUrl &&
      JSON.stringify([...existingProvider.models].sort((a, b) => a.id.localeCompare(b.id))) ===
        JSON.stringify([...newModels].sort((a, b) => a.id.localeCompare(b.id)));

    piFile.providers[endpoint.id] = {
      baseUrl: endpoint.baseUrl,
      api: 'openai-completions',
      apiKey: resolveApiKeyValue(endpoint),
      models: newModels,
    };
    nextManaged[endpoint.id] = desired.map((m) => m.id);
    entries.push({
      providerId: endpoint.id,
      baseUrl: endpoint.baseUrl,
      action: unchanged ? 'unchanged' : existingProvider ? 'updated' : 'added',
      modelIds: desired.map((m) => m.id),
    });
  }

  if (!opts.dryRun) {
    await writeJsonFile(modelsPath, piFile);
    await writeJsonFile(ledgerPath, { managed: nextManaged });
  }

  return { modelsPath, ledgerPath, entries };
}
