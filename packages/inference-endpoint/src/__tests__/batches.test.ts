import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { request } from 'http';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { BatchUnsupportedError, localQueueDriver } from '@agentproto/batch';
import type {
  AnthropicMessage,
  BatchCounts,
  BatchDriver,
  BatchHandle,
  BatchRequest,
  BatchResult,
  BatchState,
  BatchStore,
  LocalQueueDriver,
} from '@agentproto/batch';

// Dummy upstream keys so credential resolution never short-circuits with a
// missing-key 401 before reaching the driver-dispatch logic under test.
process.env.ANTHROPIC_API_KEY = 'test-anthropic';
process.env.MOONSHOT_API_KEY = 'test-moonshot';
process.env.OPENROUTER_API_KEY = 'test-openrouter';

// Isolated, writable state dir for this file's durable-record assertions
// (cancel-note persistence, restart). Removed in the top-level afterEach.
const STATE_DIR = mkdtempSync(path.join(tmpdir(), 'llm-endpoint-batches-'));
process.env.LLM_ENDPOINT_STATE_DIR = STATE_DIR;

// Gate ON for this whole file (proves the internal-loopback bypass without
// disturbing every other test file's gate-off default — Vitest isolates each
// test file's module registry, so this doesn't leak).
process.env.LLM_ENDPOINT_ACCESS_TOKENS = 'test-batches-access-token';

const { server } = await import('../index.js');
const { configureBatchDrivers, resetBatchState, getInternalProxyToken } = await import('../batches.js');

const AUTH = { Authorization: 'Bearer test-batches-access-token' };

function httpRequest(
  port: number,
  urlPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...AUTH, ...options.headers },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(data), raw: data });
          } catch {
            resolve({ status: res.statusCode || 0, body: data, raw: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

function neverResolvingComplete(): Promise<AnthropicMessage> {
  return new Promise(() => {
    // never settles — keeps the local-queue sub-batch permanently "processing"
    // without any real I/O, so tests that don't care about local-queue
    // completion stay fast and network-free.
  });
}

function stallingLocalQueue(opts: { store: BatchStore; concurrency: number }): LocalQueueDriver {
  return localQueueDriver({ store: opts.store, concurrency: opts.concurrency, complete: neverResolvingComplete });
}

interface FakeDriver extends BatchDriver {
  submitted: BatchRequest[][];
  cancelCalls: BatchHandle[];
}

function makeFakeDriver(
  kind: string,
  opts: {
    status?: (handle: BatchHandle) => Promise<{ state: BatchState; counts: BatchCounts }>;
    results?: BatchResult[];
    onResults?: () => void;
    cancel?: (handle: BatchHandle) => Promise<void>;
  } = {},
): FakeDriver {
  const submitted: BatchRequest[][] = [];
  const cancelCalls: BatchHandle[] = [];
  return {
    id: kind,
    submitted,
    cancelCalls,
    async submit(requests) {
      submitted.push([...requests]);
      const handle: BatchHandle = {
        id: `b_fake_${kind}_${submitted.length}`,
        driver: kind,
        provider: { batchIds: [`prov_${kind}_${submitted.length}`] },
        createdAt: new Date().toISOString(),
        requestCount: requests.length,
        models: Array.from(new Set(requests.map((r) => r.body.model))),
      };
      return handle;
    },
    async status(handle) {
      if (opts.status) return opts.status(handle);
      return { state: 'in_progress', counts: { processing: handle.requestCount, succeeded: 0, errored: 0, canceled: 0, expired: 0 } };
    },
    async *results() {
      opts.onResults?.();
      for (const r of opts.results ?? []) yield r;
    },
    async cancel(handle) {
      cancelCalls.push(handle);
      if (opts.cancel) return opts.cancel(handle);
    },
  };
}

function listen(): { close: () => void; port: number } {
  const srv = server.listen(0);
  const address = srv.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { close: () => srv.close(), port };
}

beforeEach(() => {
  resetBatchState();
  configureBatchDrivers({ localQueue: stallingLocalQueue });
});

afterEach(() => {
  resetBatchState();
});

afterAll(() => {
  rmSync(STATE_DIR, { recursive: true, force: true });
});

describe('POST /v1/messages/batches — create', () => {
  it('splits requests by provider into one sub-batch per driver, trims tools, rewrites model', async () => {
    const anthropic = makeFakeDriver('anthropic');
    configureBatchDrivers({ anthropic: () => anthropic, localQueue: stallingLocalQueue });

    const { close, port } = listen();
    try {
      const res = await httpRequest(port, '/v1/messages/batches', {
        method: 'POST',
        headers: { 'X-Proxy-Tools': 'Bash,Read' },
        body: {
          requests: [
            {
              custom_id: 'a1',
              params: {
                model: 'anthropic/claude-sonnet-5',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
                tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'Write' }],
              },
            },
            {
              custom_id: 'a2',
              params: {
                model: 'anthropic/claude-sonnet-5',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hi again' }],
              },
            },
            {
              custom_id: 'm1',
              params: {
                model: 'moonshot/kimi-k2.7-code',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hi from moonshot' }],
              },
            },
          ],
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.type).toBe('message_batch');
      expect(res.body.request_counts.processing).toBe(3);

      expect(anthropic.submitted).toHaveLength(1);
      const anthropicRequests = anthropic.submitted[0]!;
      expect(anthropicRequests).toHaveLength(2);
      expect(anthropicRequests.map((r) => r.customId).sort()).toEqual(['a1', 'a2']);
      const a1 = anthropicRequests.find((r) => r.customId === 'a1')!;
      expect(a1.body.model).toBe('claude-sonnet-5'); // resolved, no "anthropic/" prefix
      expect(a1.body.tools).toEqual([{ name: 'Bash' }, { name: 'Read' }]); // trimmed to the allow-list
    } finally {
      close();
    }
  });
});

describe('GET /v1/messages/batches/:id — retrieve', () => {
  it('aggregates counts/state across sub-batches; results_url only appears once ended', async () => {
    let anthropicEnded = false;
    let openrouterEnded = false;
    const anthropic = makeFakeDriver('anthropic', {
      status: async (h) => ({
        state: anthropicEnded ? 'ended' : 'in_progress',
        counts: anthropicEnded
          ? { processing: 0, succeeded: h.requestCount, errored: 0, canceled: 0, expired: 0 }
          : { processing: h.requestCount, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      }),
    });
    const openrouter = makeFakeDriver('openrouter', {
      status: async (h) => ({
        state: openrouterEnded ? 'ended' : 'in_progress',
        counts: openrouterEnded
          ? { processing: 0, succeeded: h.requestCount, errored: 0, canceled: 0, expired: 0 }
          : { processing: h.requestCount, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      }),
    });
    configureBatchDrivers({ anthropic: () => anthropic, openrouter: () => openrouter, localQueue: stallingLocalQueue });

    const { close, port } = listen();
    try {
      const create = await httpRequest(port, '/v1/messages/batches', {
        method: 'POST',
        body: {
          requests: [
            { custom_id: 'a1', params: { model: 'anthropic/claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } },
            { custom_id: 'o1', params: { model: 'openrouter/z-ai/glm-5.2', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } },
          ],
        },
      });
      expect(create.status).toBe(200);
      const id = create.body.id as string;

      const midway = await httpRequest(port, `/v1/messages/batches/${id}`);
      expect(midway.status).toBe(200);
      expect(midway.body.processing_status).toBe('in_progress');
      expect(midway.body.results_url).toBeNull();

      anthropicEnded = true;
      const stillPartial = await httpRequest(port, `/v1/messages/batches/${id}`);
      expect(stillPartial.body.processing_status).toBe('in_progress');
      expect(stillPartial.body.results_url).toBeNull();

      openrouterEnded = true;
      const done = await httpRequest(port, `/v1/messages/batches/${id}`);
      expect(done.status).toBe(200);
      expect(done.body.processing_status).toBe('ended');
      expect(done.body.results_url).toBe(`/v1/messages/batches/${id}/results`);
      expect(done.body.request_counts.succeeded).toBe(2);
    } finally {
      close();
    }
  });
});

describe('GET /v1/messages/batches/:id/results', () => {
  it('returns JSONL, one line per custom_id, mixed outcomes, and caches after the first fetch', async () => {
    let resultsCalls = 0;
    const succeededMessage: AnthropicMessage = {
      content: [{ type: 'text', text: 'ok' }],
      model: 'claude-sonnet-5',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const anthropic = makeFakeDriver('anthropic', {
      status: async (h) => ({ state: 'ended', counts: { processing: 0, succeeded: 1, errored: 1, canceled: 0, expired: 1 } }),
      onResults: () => {
        resultsCalls++;
      },
      results: [
        { customId: 'ok1', outcome: 'succeeded', message: succeededMessage },
        { customId: 'err1', outcome: 'errored', error: { type: 'api_error', message: 'boom' } },
        { customId: 'exp1', outcome: 'expired' },
      ],
    });
    configureBatchDrivers({ anthropic: () => anthropic, localQueue: stallingLocalQueue });

    const { close, port } = listen();
    try {
      const create = await httpRequest(port, '/v1/messages/batches', {
        method: 'POST',
        body: {
          requests: [
            { custom_id: 'ok1', params: { model: 'anthropic/claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } },
            { custom_id: 'err1', params: { model: 'anthropic/claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } },
            { custom_id: 'exp1', params: { model: 'anthropic/claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } },
          ],
        },
      });
      const id = create.body.id as string;

      const first = await httpRequest(port, `/v1/messages/batches/${id}/results`);
      expect(first.status).toBe(200);
      const lines: any[] = String(first.raw)
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(3);
      const byId = Object.fromEntries(lines.map((l) => [l.custom_id, l.result]));
      expect(byId.ok1.type).toBe('succeeded');
      expect(byId.ok1.message.content[0].text).toBe('ok');
      expect(byId.err1).toEqual({ type: 'errored', error: { type: 'api_error', message: 'boom' } });
      expect(byId.exp1).toEqual({ type: 'expired' });
      expect(resultsCalls).toBe(1);

      const second = await httpRequest(port, `/v1/messages/batches/${id}/results`);
      expect(second.status).toBe(200);
      expect(resultsCalls).toBe(1); // served from the cache — driver.results() not called again
    } finally {
      close();
    }
  });
});

describe('POST /v1/messages/batches — validation', () => {
  it('rejects a duplicate custom_id with 400', async () => {
    const { close, port } = listen();
    try {
      const res = await httpRequest(port, '/v1/messages/batches', {
        method: 'POST',
        body: {
          requests: [
            { custom_id: 'dup', params: { model: 'anthropic/claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } },
            { custom_id: 'dup', params: { model: 'anthropic/claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } },
          ],
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('dup');
    } finally {
      close();
    }
  });

  it('rejects stream:true naming the custom_id with 400', async () => {
    const { close, port } = listen();
    try {
      const res = await httpRequest(port, '/v1/messages/batches', {
        method: 'POST',
        body: {
          requests: [
            {
              custom_id: 'streamer',
              params: { model: 'anthropic/claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], stream: true },
            },
          ],
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('streamer');
      expect(res.body.error.message).toContain('stream');
    } finally {
      close();
    }
  });

  it('rejects an unknown model with 400', async () => {
    const { close, port } = listen();
    try {
      const res = await httpRequest(port, '/v1/messages/batches', {
        method: 'POST',
        body: {
          requests: [
            { custom_id: 'bad-model', params: { model: 'totally-unknown-model', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } },
          ],
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('bad-model');
    } finally {
      close();
    }
  });
});

describe('POST /v1/messages/batches/:id/cancel', () => {
  it('cancels every sub-batch; an unsupported cancel is recorded, not fatal', async () => {
    const anthropic = makeFakeDriver('anthropic');
    const openrouter = makeFakeDriver('openrouter', {
      cancel: async () => {
        throw new BatchUnsupportedError('cancel', 'openrouter');
      },
    });
    configureBatchDrivers({ anthropic: () => anthropic, openrouter: () => openrouter, localQueue: stallingLocalQueue });

    const { close, port } = listen();
    try {
      const create = await httpRequest(port, '/v1/messages/batches', {
        method: 'POST',
        body: {
          requests: [
            { custom_id: 'a1', params: { model: 'anthropic/claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } },
            { custom_id: 'o1', params: { model: 'openrouter/z-ai/glm-5.2', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } },
          ],
        },
      });
      const id = create.body.id as string;

      const cancel = await httpRequest(port, `/v1/messages/batches/${id}/cancel`, { method: 'POST' });
      expect(cancel.status).toBe(200);
      expect(cancel.body.processing_status).toBe('canceling');
      expect(anthropic.cancelCalls).toHaveLength(1);
      expect(openrouter.cancelCalls).toHaveLength(1);

      const persisted = JSON.parse(readFileSync(path.join(STATE_DIR, 'proxy-batches', `${id}.json`), 'utf8'));
      const openrouterSub = persisted.subBatches.find((s: any) => s.provider === 'openrouter');
      expect(openrouterSub.cancelError).toContain('openrouter');
      const anthropicSub = persisted.subBatches.find((s: any) => s.provider === 'anthropic');
      expect(anthropicSub.cancelError).toBeNull();
    } finally {
      close();
    }
  });
});

describe('access gate', () => {
  it('401s a request with no token', async () => {
    const { close, port } = listen();
    try {
      const res = await httpRequest(port, '/v1/messages/batches', { headers: { Authorization: '' } });
      expect(res.status).toBe(401);
    } finally {
      close();
    }
  });

  it('401s a request with the wrong X-Proxy-Internal value and no access token', async () => {
    const { close, port } = listen();
    try {
      const res = await httpRequest(port, '/v1/messages/batches', {
        headers: { Authorization: '', 'X-Proxy-Internal': 'not-the-real-token' },
      });
      expect(res.status).toBe(401);
    } finally {
      close();
    }
  });

  it('accepts the correct X-Proxy-Internal token in place of an access token', async () => {
    const { close, port } = listen();
    try {
      // A single-item GET (rather than list, which would aggregate status
      // across every batch this file has created so far) — a 404 for an
      // unknown id proves the request cleared the gate into the route
      // handler; a 401 would mean the bypass failed.
      const res = await httpRequest(port, '/v1/messages/batches/msgbatch_does_not_exist', {
        headers: { Authorization: '', 'X-Proxy-Internal': getInternalProxyToken() },
      });
      expect(res.status).toBe(404);
    } finally {
      close();
    }
  });
});

describe('local-queue transport', () => {
  it('runs items through an injected complete() and lands a succeeded result line', async () => {
    let completeCalls = 0;
    configureBatchDrivers({
      localQueue: (opts) =>
        localQueueDriver({
          store: opts.store,
          concurrency: opts.concurrency,
          complete: async (body) => {
            completeCalls++;
            expect(body.model.startsWith('moonshot/')).toBe(true); // provider-prefixed for loopback re-resolution
            return { content: [{ type: 'text', text: 'local-queue ok' }], model: body.model, usage: { input_tokens: 1, output_tokens: 1 } };
          },
        }),
    });

    const { close, port } = listen();
    try {
      const create = await httpRequest(port, '/v1/messages/batches', {
        method: 'POST',
        body: {
          requests: [
            { custom_id: 'lq1', params: { model: 'moonshot/kimi-k2.7-code', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } },
          ],
        },
      });
      expect(create.status).toBe(200);
      const id = create.body.id as string;

      // resume() runs in the background — poll retrieve until it lands.
      let retrieved = create.body;
      for (let i = 0; i < 50 && retrieved.processing_status !== 'ended'; i++) {
        await new Promise((r) => setTimeout(r, 20));
        const res = await httpRequest(port, `/v1/messages/batches/${id}`);
        retrieved = res.body;
      }
      expect(retrieved.processing_status).toBe('ended');
      expect(completeCalls).toBe(1);

      const results = await httpRequest(port, `/v1/messages/batches/${id}/results`);
      const lines = String(results.raw)
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(1);
      expect(lines[0].custom_id).toBe('lq1');
      expect(lines[0].result.type).toBe('succeeded');
      expect(lines[0].result.message.content[0].text).toBe('local-queue ok');
    } finally {
      close();
    }
  });
});

describe('restart durability', () => {
  it('a batch created before resetBatchState() still GETs correctly after', async () => {
    const anthropic = makeFakeDriver('anthropic');
    configureBatchDrivers({ anthropic: () => anthropic, localQueue: stallingLocalQueue });

    const { close, port } = listen();
    try {
      const create = await httpRequest(port, '/v1/messages/batches', {
        method: 'POST',
        body: {
          requests: [
            { custom_id: 'r1', params: { model: 'anthropic/claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } },
          ],
        },
      });
      expect(create.status).toBe(200);
      const id = create.body.id as string;

      // Simulate a process restart: drop in-memory driver overrides/caches,
      // then re-arm the same fakes (a real restart keeps the same code, just
      // loses in-memory state) and prove the durable record still resolves.
      resetBatchState();
      configureBatchDrivers({ anthropic: () => anthropic, localQueue: stallingLocalQueue });

      const res = await httpRequest(port, `/v1/messages/batches/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(id);
      expect(res.body.request_counts.processing).toBe(1);
    } finally {
      close();
    }
  });
});

