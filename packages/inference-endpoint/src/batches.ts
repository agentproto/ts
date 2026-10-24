/**
 * `/v1/messages/batches*` — an Anthropic-shaped Batches surface on top of
 * `@agentproto/batch`. Batch is a delivery mode, not a model: each item's
 * `params` is the same Messages body the sync `/v1/messages` route already
 * understands, so per-item routing/tool-trimming is reused verbatim from
 * `index.ts` (hence the circular import — both sides only touch the other's
 * exports from inside a function body, never at module top level, so ESM's
 * circular-resolution rules leave it safe).
 *
 * Per resolved provider:
 *   - anthropic  → native Anthropic Message Batches (50%, 24h window).
 *   - openrouter → native OpenRouter Batch API (50%, one provider batch per model).
 *   - everything else → localQueueDriver emulation: items are run through the
 *     proxy's OWN sync /v1/messages path over loopback, full price.
 * A batch spanning several providers is split into sub-batches keyed by
 * `custom_id` and re-aggregated on every read.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  anthropicBatchDriver,
  anthropicMessageSchema,
  assertUniqueCustomIds,
  batchHandleSchema,
  BatchStore,
  BatchUnsupportedError,
  BatchValidationError,
  localQueueDriver,
  messagesBodySchema,
  newBatchId,
  openrouterBatchDriver,
  RetryableCompletionError,
  ulid,
  validateForBatch,
  type AnthropicMessage,
  type BatchCounts,
  type BatchDriver,
  type BatchHandle,
  type BatchOutcome,
  type BatchRequest,
  type BatchResultError,
  type LocalQueueDriver,
  type MessagesBody,
} from '@agentproto/batch';
import { resolveModelRoute, resolveUpstreamCredential, stripThinkingFromAnthropicJson, trimTools } from './index.js';
import type { ModelRouteContext, UpstreamCredential } from './index.js';
import type { ModelPack } from './packs.js';

// ── Process-local loopback bypass token ─────────────────────────────────────
// Generated once per process, kept in memory only (never persisted, never
// logged). The local-queue transport attaches it as `X-Proxy-Internal` on its
// loopback call to this proxy's own `/v1/messages`; the gate in index.ts
// accepts it as an alternative to a normal access token so the internal call
// isn't itself blocked by LLM_ENDPOINT_ACCESS_TOKENS/LLM_ENDPOINT_EDGE_TOKENS.
const INTERNAL_TOKEN = randomBytes(32).toString('hex');

/** The process-local loopback bypass token. Exported for tests; treat as a secret. */
export function getInternalProxyToken(): string {
  return INTERNAL_TOKEN;
}

/** True when `headers` carry the correct `X-Proxy-Internal` token. */
export function isInternalLoopbackRequest(headers: IncomingMessage['headers']): boolean {
  const raw = headers['x-proxy-internal'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && value === INTERNAL_TOKEN;
}

// ── Config ───────────────────────────────────────────────────────────────

const BATCH_TTL_MS = 24 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 29 * 24 * 60 * 60 * 1000;
const DEFAULT_LOCAL_QUEUE_CONCURRENCY = 4;

function stateDir(): string {
  return process.env.LLM_ENDPOINT_STATE_DIR || path.join(homedir(), '.agentproto', 'llm-endpoint');
}

function batchConcurrency(): number {
  const raw = process.env.LLM_ENDPOINT_BATCH_CONCURRENCY;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOCAL_QUEUE_CONCURRENCY;
}

function defaultLoopbackPort(): number {
  const raw = process.env.LLM_ENDPOINT_PORT ?? process.env.PORT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : 18090;
}

// ── Durable proxy-level batch record ────────────────────────────────────────
// A composite record over one or more @agentproto/batch sub-batches, stored
// as its own small JSON file under `<stateDir>/proxy-batches/<id>.json` — a
// distinct namespace from `@agentproto/batch`'s own `<stateDir>/batches/<id>/`
// layout (used below for the local-queue driver's per-item store), so the two
// never collide even though they share a state root.

const proxySubBatchSchema = z.object({
  provider: z.enum(['anthropic', 'openrouter', 'local-queue']),
  handle: batchHandleSchema,
  customIds: z.array(z.string()),
  cancelError: z.string().nullable(),
});

type ProxySubBatch = z.infer<typeof proxySubBatchSchema>;
type BatchDriverKind = ProxySubBatch['provider'];

const batchResultErrorShapeSchema = z.object({ type: z.string(), message: z.string() });

const resultLineOutcomeSchema = z.union([
  z.object({ type: z.literal('succeeded'), message: anthropicMessageSchema }),
  z.object({ type: z.literal('errored'), error: batchResultErrorShapeSchema }),
  z.object({ type: z.literal('canceled') }),
  z.object({ type: z.literal('expired') }),
]);

const cachedResultLineSchema = z.object({
  customId: z.string(),
  result: resultLineOutcomeSchema,
});

type CachedResultLine = z.infer<typeof cachedResultLineSchema>;

const proxyBatchRecordSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  cancelInitiatedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  subBatches: z.array(proxySubBatchSchema),
  cachedResults: z.array(cachedResultLineSchema).nullable(),
});

type ProxyBatchRecord = z.infer<typeof proxyBatchRecordSchema>;

function newProxyBatchId(): string {
  return `msgbatch_${ulid()}`;
}

class ProxyBatchFileStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async save(record: ProxyBatchRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(record.id);
    const tmp = `${target}.tmp-${randomBytes(8).toString('hex')}`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
    await rename(tmp, target);
  }

  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }

  /** Loads a record, pruning (and returning `undefined` for) one older than 29 days. */
  async load(id: string): Promise<ProxyBatchRecord | undefined> {
    const raw = await readFile(this.file(id), 'utf8').catch(() => undefined);
    if (raw === undefined) return undefined;
    const record = proxyBatchRecordSchema.parse(JSON.parse(raw));
    if (Date.now() - Date.parse(record.createdAt) > PRUNE_AFTER_MS) {
      await this.remove(id);
      return undefined;
    }
    return record;
  }

  async list(): Promise<ProxyBatchRecord[]> {
    const entries = await readdir(this.dir).catch((): string[] => []);
    const records: ProxyBatchRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.includes('.tmp-')) continue;
      const record = await this.load(entry.slice(0, -'.json'.length));
      if (record) records.push(record);
    }
    return records;
  }
}

let _proxyStore: ProxyBatchFileStore | undefined;
function proxyStore(): ProxyBatchFileStore {
  if (!_proxyStore) _proxyStore = new ProxyBatchFileStore(path.join(stateDir(), 'proxy-batches'));
  return _proxyStore;
}

let _localQueueStore: BatchStore | undefined;
function localQueueStore(): BatchStore {
  if (!_localQueueStore) _localQueueStore = new BatchStore({ stateDir: stateDir() });
  return _localQueueStore;
}

// ── Test seam ────────────────────────────────────────────────────────────

export interface BatchDriverFactories {
  anthropic?: (opts: { apiKey: string }) => BatchDriver;
  openrouter?: (opts: { apiKey: string }) => BatchDriver;
  localQueue?: (opts: { store: BatchStore; concurrency: number }) => LocalQueueDriver;
}

let driverOverrides: BatchDriverFactories = {};

/** Test seam: inject fake drivers keyed by provider. See `resetBatchState`. */
export function configureBatchDrivers(factories: BatchDriverFactories): void {
  driverOverrides = factories;
}

/** Resets driver overrides and cached store handles — call between tests. */
export function resetBatchState(): void {
  driverOverrides = {};
  _proxyStore = undefined;
  _localQueueStore = undefined;
}

// ── Loopback transport for local-queue emulation ────────────────────────────

function makeLoopbackComplete(port: number): (body: MessagesBody) => Promise<AnthropicMessage> {
  return (body: MessagesBody) =>
    new Promise<AnthropicMessage>((resolve, reject) => {
      const payload = JSON.stringify(body);
      const outgoing = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'X-Proxy-Internal': INTERNAL_TOKEN,
          },
        },
        (loopbackRes) => {
          let data = '';
          loopbackRes.setEncoding('utf8');
          loopbackRes.on('data', (chunk: string) => {
            data += chunk;
          });
          loopbackRes.on('end', () => {
            const status = loopbackRes.statusCode ?? 0;
            if (status === 429 || status >= 500) {
              reject(new RetryableCompletionError(`loopback /v1/messages returned ${status}`, status));
              return;
            }
            if (status >= 400) {
              reject(new Error(`loopback /v1/messages returned ${status}: ${data.slice(0, 200)}`));
              return;
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              reject(new Error('loopback /v1/messages returned invalid JSON'));
              return;
            }
            const result = anthropicMessageSchema.safeParse(parsed);
            if (!result.success) {
              reject(new Error('loopback /v1/messages returned an unexpected message shape'));
              return;
            }
            resolve(result.data);
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.write(payload);
      outgoing.end();
    });
}

function defaultLocalQueueDriver(opts: { store: BatchStore; concurrency: number }, port: number): LocalQueueDriver {
  return localQueueDriver({ store: opts.store, concurrency: opts.concurrency, complete: makeLoopbackComplete(port) });
}

function localQueueDriverInstance(port: number): LocalQueueDriver {
  const factory = driverOverrides.localQueue ?? ((o: { store: BatchStore; concurrency: number }) => defaultLocalQueueDriver(o, port));
  return factory({ store: localQueueStore(), concurrency: batchConcurrency() });
}

/** Thrown when a resolved credential can't be used for batch operations — mapped to a 401. */
class BatchCredentialError extends Error {}

async function getDriverForSubBatch(sub: ProxySubBatch, port: number): Promise<BatchDriver> {
  if (sub.provider === 'anthropic') {
    const cred = await resolveUpstreamCredential('anthropic');
    if (!cred || !cred.value) throw new BatchCredentialError('No API key for provider "anthropic"');
    if (cred.method !== 'api-key') {
      throw new BatchCredentialError(
        'Anthropic batches require an API key credential; the resolved credential is a subscription OAuth token, which cannot be used with the Batches API.',
      );
    }
    return (driverOverrides.anthropic ?? ((o: { apiKey: string }) => anthropicBatchDriver(o)))({ apiKey: cred.value });
  }
  if (sub.provider === 'openrouter') {
    const cred = await resolveUpstreamCredential('openrouter');
    if (!cred || !cred.value) throw new BatchCredentialError('No API key for provider "openrouter"');
    return (driverOverrides.openrouter ?? ((o: { apiKey: string }) => openrouterBatchDriver(o)))({ apiKey: cred.value });
  }
  return localQueueDriverInstance(port);
}

function batchDriverKind(provider: string): BatchDriverKind {
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'openrouter') return 'openrouter';
  return 'local-queue';
}

// ── Aggregate status across sub-batches ─────────────────────────────────────

interface AggregateStatus {
  state: 'in_progress' | 'canceling' | 'ended';
  counts: BatchCounts;
  endedAt: string | null;
}

async function computeAggregateStatus(record: ProxyBatchRecord, port: number): Promise<AggregateStatus> {
  const counts: BatchCounts = { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 };
  let allTerminal = true;
  for (const sub of record.subBatches) {
    const driver = await getDriverForSubBatch(sub, port);
    const status = await driver.status(sub.handle);
    counts.processing += status.counts.processing;
    counts.succeeded += status.counts.succeeded;
    counts.errored += status.counts.errored;
    counts.canceled += status.counts.canceled;
    counts.expired += status.counts.expired;
    if (status.state !== 'ended' && status.state !== 'failed') allTerminal = false;
  }
  if (!allTerminal) {
    return { state: record.cancelInitiatedAt ? 'canceling' : 'in_progress', counts, endedAt: null };
  }
  return { state: 'ended', counts, endedAt: record.endedAt ?? new Date().toISOString() };
}

async function getStatusAndPersist(record: ProxyBatchRecord, port: number): Promise<AggregateStatus> {
  const status = await computeAggregateStatus(record, port);
  if (status.endedAt && !record.endedAt) {
    record.endedAt = status.endedAt;
    await proxyStore().save(record);
  }
  return status;
}

function toBatchObject(record: ProxyBatchRecord, status: AggregateStatus) {
  return {
    id: record.id,
    type: 'message_batch' as const,
    processing_status: status.state,
    request_counts: status.counts,
    ended_at: status.endedAt,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    cancel_initiated_at: record.cancelInitiatedAt,
    results_url: status.state === 'ended' ? `/v1/messages/batches/${record.id}/results` : null,
    archived_at: null,
  };
}

function toResultShape(
  outcome: BatchOutcome,
  message: AnthropicMessage | undefined,
  error: BatchResultError | undefined,
): CachedResultLine['result'] {
  switch (outcome) {
    case 'succeeded':
      if (!message) return { type: 'errored', error: { type: 'api_error', message: 'succeeded result missing a message' } };
      return { type: 'succeeded', message };
    case 'errored':
      return { type: 'errored', error: error ?? { type: 'api_error', message: 'unknown error' } };
    case 'canceled':
      return { type: 'canceled' };
    case 'expired':
      return { type: 'expired' };
  }
}

// ── Inbound validation ───────────────────────────────────────────────────

const batchCreateItemSchema = z.object({
  custom_id: z.string().min(1),
  params: messagesBodySchema,
});

const batchCreateBodySchema = z.object({
  requests: z.array(batchCreateItemSchema).min(1),
});

function describeZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

// ── HTTP plumbing ──────────────────────────────────────────────────────────

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function invalidRequest(message: string) {
  return { error: { type: 'invalid_request_error', message } };
}

function notFoundBatch(id: string) {
  return { error: { type: 'not_found_error', message: `Batch "${id}" not found.` } };
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export interface BatchesRequestContext {
  activePack: ModelPack;
  parsedUrl: URL;
  queryModelCode: string | null;
  queryProvider: string | null;
  forcedAliasCode: string | null;
  anthropicFormat: boolean;
  queryTools: string | null;
  queryNoTools: string | null;
  headerTools: string | null;
  headerNoTools: string | null;
  headerExcludeTools: string | null;
}

type BatchesRouteMatch =
  | { kind: 'collection' }
  | { kind: 'item'; id: string }
  | { kind: 'results'; id: string }
  | { kind: 'cancel'; id: string };

const BATCHES_PATH_MARKER = '/messages/batches';

function matchBatchesPath(urlPath: string): BatchesRouteMatch | null {
  const idx = urlPath.indexOf(BATCHES_PATH_MARKER);
  if (idx === -1) return null;
  const rest = urlPath.slice(idx + BATCHES_PATH_MARKER.length);
  if (rest === '') return { kind: 'collection' };
  const segments = rest.split('/').filter((s) => s.length > 0);
  const id = segments[0];
  if (id === undefined) return null;
  if (segments.length === 1) return { kind: 'item', id };
  const sub = segments[1];
  if (segments.length === 2 && sub === 'results') return { kind: 'results', id };
  if (segments.length === 2 && sub === 'cancel') return { kind: 'cancel', id };
  return null;
}

/**
 * Entry point wired from `index.ts`'s dispatch. Returns `true` (and takes
 * over the response, asynchronously) when `ctx`'s path is a batches route;
 * `false` lets the caller fall through to the rest of the dispatch.
 */
export function handleBatchesRequest(req: IncomingMessage, res: ServerResponse, ctx: BatchesRequestContext, urlPath: string): boolean {
  const match = matchBatchesPath(urlPath);
  if (!match) return false;
  void dispatchBatchesRequest(req, res, ctx, match).catch((err: unknown) => {
    if (err instanceof BatchCredentialError) {
      respondJson(res, 401, { error: { type: 'authentication_error', message: err.message } });
      return;
    }
    console.error('[Proxy][batches] unhandled error', err);
    if (res.headersSent) {
      res.end();
      return;
    }
    respondJson(res, 500, { error: { type: 'api_error', message: err instanceof Error ? err.message : 'internal error' } });
  });
  return true;
}

async function dispatchBatchesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: BatchesRequestContext,
  match: BatchesRouteMatch,
): Promise<void> {
  const method = req.method ?? 'GET';
  const port = req.socket.localPort ?? defaultLoopbackPort();

  if (match.kind === 'collection') {
    if (method === 'POST') return handleCreate(req, res, ctx, port);
    if (method === 'GET') return handleList(res, ctx.parsedUrl, port);
    return respondJson(res, 404, { error: { type: 'not_found', message: 'Route not found' } });
  }
  if (match.kind === 'item') {
    if (method === 'GET') return handleRetrieve(res, match.id, port);
    if (method === 'DELETE') return handleDeleteBatch(res, match.id, port);
    return respondJson(res, 404, { error: { type: 'not_found', message: 'Route not found' } });
  }
  if (match.kind === 'results') {
    if (method === 'GET') return handleResults(res, match.id, port);
    return respondJson(res, 404, { error: { type: 'not_found', message: 'Route not found' } });
  }
  if (method === 'POST') return handleCancel(res, match.id, port);
  return respondJson(res, 404, { error: { type: 'not_found', message: 'Route not found' } });
}

// ── Create ───────────────────────────────────────────────────────────────

async function handleCreate(req: IncomingMessage, res: ServerResponse, ctx: BatchesRequestContext, port: number): Promise<void> {
  const raw = await readRequestBody(req);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    respondJson(res, 400, invalidRequest('Invalid JSON body'));
    return;
  }

  const parsedBody = batchCreateBodySchema.safeParse(json);
  if (!parsedBody.success) {
    respondJson(res, 400, invalidRequest(describeZodError(parsedBody.error)));
    return;
  }
  const items = parsedBody.data.requests;

  try {
    assertUniqueCustomIds(items.map((item) => ({ customId: item.custom_id, body: item.params })));
  } catch (err) {
    if (!(err instanceof BatchValidationError)) throw err;
    respondJson(res, 400, invalidRequest(err.message));
    return;
  }

  const problems: string[] = [];
  for (const item of items) {
    try {
      validateForBatch({ customId: item.custom_id, body: item.params });
    } catch (err) {
      if (!(err instanceof BatchValidationError)) throw err;
      problems.push(err.message);
    }
  }
  if (problems.length > 0) {
    respondJson(res, 400, invalidRequest(problems.join('; ')));
    return;
  }

  const routeCtx: ModelRouteContext = {
    activePack: ctx.activePack,
    queryModelCode: ctx.queryModelCode,
    queryProvider: ctx.queryProvider,
    forcedAliasCode: ctx.forcedAliasCode,
    allowAliases: true,
    anthropicFormat: ctx.anthropicFormat,
  };

  interface ResolvedItem {
    customId: string;
    provider: string;
    body: MessagesBody;
  }
  const resolved: ResolvedItem[] = [];
  for (const item of items) {
    let target: { provider: string; model: string };
    try {
      target = resolveModelRoute(item.params, routeCtx);
    } catch (err) {
      problems.push(`"${item.custom_id}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const body: MessagesBody = { ...item.params, model: target.model };
    trimTools(body, {
      provider: target.provider,
      queryTools: ctx.queryTools,
      queryNoTools: ctx.queryNoTools,
      headerTools: ctx.headerTools,
      headerNoTools: ctx.headerNoTools,
      headerExcludeTools: ctx.headerExcludeTools,
    });
    resolved.push({ customId: item.custom_id, provider: target.provider, body });
  }
  if (problems.length > 0) {
    respondJson(res, 400, invalidRequest(problems.join('; ')));
    return;
  }

  const groups = new Map<BatchDriverKind, BatchRequest[]>();
  for (const item of resolved) {
    const kind = batchDriverKind(item.provider);
    const body = kind === 'local-queue' ? { ...item.body, model: `${item.provider}/${item.body.model}` } : item.body;
    const list = groups.get(kind);
    if (list) list.push({ customId: item.customId, body });
    else groups.set(kind, [{ customId: item.customId, body }]);
  }

  // Resolve+validate every needed credential BEFORE submitting anything, so a
  // missing credential for one provider doesn't leave another already submitted.
  const credentials = new Map<'anthropic' | 'openrouter', UpstreamCredential>();
  for (const kind of groups.keys()) {
    if (kind !== 'anthropic' && kind !== 'openrouter') continue;
    const cred = await resolveUpstreamCredential(kind);
    if (!cred || !cred.value) {
      respondJson(res, 401, { error: { type: 'authentication_error', message: `No API key for provider "${kind}"` } });
      return;
    }
    if (kind === 'anthropic' && cred.method !== 'api-key') {
      respondJson(res, 401, {
        error: {
          type: 'authentication_error',
          message:
            'Anthropic batches require an API key credential; the resolved credential is a subscription OAuth token, which cannot be used with the Batches API.',
        },
      });
      return;
    }
    credentials.set(kind, cred);
  }

  const subBatches: ProxySubBatch[] = [];
  for (const [kind, requests] of groups) {
    if (kind === 'anthropic') {
      const cred = credentials.get('anthropic');
      if (!cred) throw new Error('anthropic credential resolved but missing from cache');
      const driver = (driverOverrides.anthropic ?? ((o: { apiKey: string }) => anthropicBatchDriver(o)))({ apiKey: cred.value });
      const handle = await driver.submit(requests);
      subBatches.push({ provider: 'anthropic', handle, customIds: requests.map((r) => r.customId), cancelError: null });
    } else if (kind === 'openrouter') {
      const cred = credentials.get('openrouter');
      if (!cred) throw new Error('openrouter credential resolved but missing from cache');
      const driver = (driverOverrides.openrouter ?? ((o: { apiKey: string }) => openrouterBatchDriver(o)))({ apiKey: cred.value });
      const handle = await driver.submit(requests);
      subBatches.push({ provider: 'openrouter', handle, customIds: requests.map((r) => r.customId), cancelError: null });
    } else {
      const handle: BatchHandle = {
        id: newBatchId(),
        driver: 'local-queue',
        provider: { batchIds: [] },
        createdAt: new Date().toISOString(),
        requestCount: requests.length,
        models: Array.from(new Set(requests.map((r) => r.body.model))),
      };
      await localQueueStore().create(handle, requests);
      const driver = localQueueDriverInstance(port);
      void driver.resume(handle).catch((err: unknown) => {
        console.error(`[Proxy][batches] local-queue batch "${handle.id}" failed`, err);
      });
      subBatches.push({ provider: 'local-queue', handle, customIds: requests.map((r) => r.customId), cancelError: null });
    }
  }

  const now = new Date();
  const record: ProxyBatchRecord = {
    id: newProxyBatchId(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + BATCH_TTL_MS).toISOString(),
    cancelInitiatedAt: null,
    endedAt: null,
    subBatches,
    cachedResults: null,
  };
  await proxyStore().save(record);
  const status = await getStatusAndPersist(record, port);
  respondJson(res, 200, toBatchObject(record, status));
}

// ── Retrieve / list ──────────────────────────────────────────────────────

async function handleRetrieve(res: ServerResponse, id: string, port: number): Promise<void> {
  const record = await proxyStore().load(id);
  if (!record) {
    respondJson(res, 404, notFoundBatch(id));
    return;
  }
  const status = await getStatusAndPersist(record, port);
  respondJson(res, 200, toBatchObject(record, status));
}

async function handleList(res: ServerResponse, parsedUrl: URL, port: number): Promise<void> {
  const records = await proxyStore().list();
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const limitParam = parsedUrl.searchParams.get('limit');
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : records.length;
  const page = records.slice(0, limit);

  const data = [];
  for (const record of page) {
    const status = await getStatusAndPersist(record, port);
    data.push(toBatchObject(record, status));
  }
  respondJson(res, 200, {
    data,
    has_more: false,
    first_id: data.length > 0 ? data[0]!.id : null,
    last_id: data.length > 0 ? data[data.length - 1]!.id : null,
  });
}

// ── Results ──────────────────────────────────────────────────────────────

async function handleResults(res: ServerResponse, id: string, port: number): Promise<void> {
  const record = await proxyStore().load(id);
  if (!record) {
    respondJson(res, 404, notFoundBatch(id));
    return;
  }
  const status = await getStatusAndPersist(record, port);
  if (status.state !== 'ended') {
    respondJson(res, 404, {
      error: { type: 'not_found_error', message: `Batch "${id}" results are not available until processing_status is "ended".` },
    });
    return;
  }

  let lines = record.cachedResults;
  if (!lines) {
    lines = [];
    for (const sub of record.subBatches) {
      const driver = await getDriverForSubBatch(sub, port);
      for await (const r of driver.results(sub.handle)) {
        let message = r.message;
        if (sub.provider === 'openrouter' && message) {
          const stripped: unknown = JSON.parse(stripThinkingFromAnthropicJson(JSON.stringify(message)));
          const strippedResult = anthropicMessageSchema.safeParse(stripped);
          if (strippedResult.success) message = strippedResult.data;
        }
        lines.push({ customId: r.customId, result: toResultShape(r.outcome, message, r.error) });
      }
    }
    record.cachedResults = lines;
    await proxyStore().save(record);
  }

  res.writeHead(200, { 'Content-Type': 'application/x-jsonl; charset=utf-8' });
  for (const line of lines) {
    res.write(`${JSON.stringify({ custom_id: line.customId, result: line.result })}\n`);
  }
  res.end();
}

// ── Cancel / delete ──────────────────────────────────────────────────────

async function handleCancel(res: ServerResponse, id: string, port: number): Promise<void> {
  const record = await proxyStore().load(id);
  if (!record) {
    respondJson(res, 404, notFoundBatch(id));
    return;
  }
  if (!record.cancelInitiatedAt) record.cancelInitiatedAt = new Date().toISOString();

  for (const sub of record.subBatches) {
    const driver = await getDriverForSubBatch(sub, port);
    try {
      await driver.cancel(sub.handle);
    } catch (err) {
      if (!(err instanceof BatchUnsupportedError)) throw err;
      sub.cancelError = err.message;
    }
  }
  await proxyStore().save(record);

  const status = await getStatusAndPersist(record, port);
  const forced: AggregateStatus = status.state === 'ended' ? status : { ...status, state: 'canceling' };
  respondJson(res, 200, toBatchObject(record, forced));
}

async function bestEffortDeleteAnthropicBatch(sub: ProxySubBatch): Promise<void> {
  const cred = await resolveUpstreamCredential('anthropic');
  if (!cred || !cred.value || cred.method !== 'api-key') return;
  const providerId = sub.handle.provider.batchIds[0];
  if (!providerId) return;
  await fetch(`https://api.anthropic.com/v1/messages/batches/${providerId}`, {
    method: 'DELETE',
    headers: { 'x-api-key': cred.value, 'anthropic-version': '2023-06-01' },
  }).catch(() => undefined);
}

async function handleDeleteBatch(res: ServerResponse, id: string, port: number): Promise<void> {
  const record = await proxyStore().load(id);
  if (!record) {
    respondJson(res, 404, notFoundBatch(id));
    return;
  }
  const status = await getStatusAndPersist(record, port);
  if (status.state !== 'ended') {
    respondJson(res, 409, invalidRequest(`Batch "${id}" cannot be deleted before it has ended.`));
    return;
  }
  for (const sub of record.subBatches) {
    if (sub.provider === 'anthropic') await bestEffortDeleteAnthropicBatch(sub);
  }
  await proxyStore().remove(id);
  respondJson(res, 200, { id, type: 'message_batch_deleted' });
}

// ── Boot-time reconciliation ─────────────────────────────────────────────

/**
 * Resumes local-queue sub-batches left unfinished by a prior process's crash.
 * Native sub-batches need no boot action — their status/results are re-polled
 * from the provider on demand using the persisted handle.
 */
export async function resumeIncompleteLocalQueueBatches(): Promise<void> {
  const port = defaultLoopbackPort();
  const records = await proxyStore().list();
  for (const record of records) {
    for (const sub of record.subBatches) {
      if (sub.provider !== 'local-queue') continue;
      const driver = localQueueDriverInstance(port);
      void driver.resume(sub.handle).catch((err: unknown) => {
        console.error(`[Proxy][batches] failed to resume local-queue batch "${sub.handle.id}" on boot`, err);
      });
    }
  }
}
