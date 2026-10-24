import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server, type IncomingMessage } from 'http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Reasoning-content passthrough (LLM_ENDPOINT_PASSTHROUGH_THINKING) is set
// ONCE for this whole file, before the server module is imported — mirrors
// packs-reload.test.ts's LLM_ENDPOINT_ACCESS_TOKENS pattern (vitest isolates
// modules per test file, so this is scoped to this file only). It only
// affects a response with empty `content` AND non-empty `reasoning_content`,
// so every other test in this file (normal text responses) is unaffected.
process.env.LLM_ENDPOINT_PASSTHROUGH_THINKING = '1';

const { server, resetConfiguredEndpointsCache } = await import('../index.js');

// ── HTTP helpers — mirrors forge.test.ts ────────────────────────────────────

function httpJson(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { hostname: 'localhost', port, path, method: options.method || 'GET', headers: options.headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolvePromise({ status: res.statusCode || 0, body: JSON.parse(data) });
          } catch {
            resolvePromise({ status: res.statusCode || 0, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

function startFakeUpstream(handler: (req: IncomingMessage, body: string) => { status: number; body: unknown }) {
  const captured: { path?: string; headers?: IncomingMessage['headers']; body?: string } = {};
  const fake: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      captured.path = req.url;
      captured.headers = req.headers;
      captured.body = body;
      const { status, body: respBody } = handler(req, body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(respBody));
    });
  });
  return { fake, captured };
}

// ── env isolation — a fresh temp endpoints file + cache reset per test ─────

const SAVED_FILE_ENV = process.env.LLM_ENDPOINT_ENDPOINTS_FILE;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'llm-named-endpoints-'));
});

afterEach(async () => {
  if (SAVED_FILE_ENV === undefined) delete process.env.LLM_ENDPOINT_ENDPOINTS_FILE;
  else process.env.LLM_ENDPOINT_ENDPOINTS_FILE = SAVED_FILE_ENV;
  resetConfiguredEndpointsCache();
  await rm(dir, { recursive: true, force: true });
});

async function configureEndpoints(endpoints: unknown[]): Promise<void> {
  const path = join(dir, 'llm-endpoints.json');
  await writeFile(path, JSON.stringify({ endpoints }));
  process.env.LLM_ENDPOINT_ENDPOINTS_FILE = path;
  resetConfiguredEndpointsCache();
}

describe('named endpoints — routing', () => {
  it('routes "<id>/<model>" through OpenAI /v1/chat/completions, no key header (apiKeyEnv unset)', async () => {
    const { fake, captured } = startFakeUpstream(() => ({
      status: 200,
      body: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hi from ep-a' }, finish_reason: 'stop' }], usage: {} },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    await configureEndpoints([{ id: 'ep-a', kind: 'openai', baseUrl: `http://127.0.0.1:${fakePort}/v1` }]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'ep-a/some-model', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(captured.path).toBe('/v1/chat/completions');
      expect(captured.headers?.authorization).toBeUndefined();
      expect(JSON.parse(captured.body!).model).toBe('some-model');
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('routes "<id>/<model>" through Anthropic /v1/messages, translating request + response', async () => {
    const { fake, captured } = startFakeUpstream(() => ({
      status: 200,
      body: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hello from ep-b' }, finish_reason: 'stop' }], usage: {} },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    await configureEndpoints([{ id: 'ep-b', kind: 'openai', baseUrl: `http://127.0.0.1:${fakePort}/v1` }]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'ep-b/some-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(captured.path).toBe('/v1/chat/completions');
      expect(res.body.role).toBe('assistant');
      expect(res.body.content).toEqual([{ type: 'text', text: 'hello from ep-b' }]);
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('sends Authorization: Bearer <key> when apiKeyEnv names a set env var', async () => {
    const { fake, captured } = startFakeUpstream(() => ({
      status: 200,
      body: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    await configureEndpoints([{ id: 'ep-c', kind: 'openai', baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKeyEnv: 'EP_C_TEST_KEY' }]);
    process.env.EP_C_TEST_KEY = 'secret-ep-c-key';

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'ep-c/some-model', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(captured.headers?.authorization).toBe('Bearer secret-ep-c-key');
    } finally {
      delete process.env.EP_C_TEST_KEY;
      srv.close();
      fakeSrv.close();
    }
  });

  it('an unknown endpoint id is not routable — a bare model without a known provider prefix 400s', async () => {
    await configureEndpoints([]);
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'not-configured/some-model', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    } finally {
      srv.close();
    }
  });

  it('defaultRequestFields.chat_template_kwargs is merged UNDER the client fields (client keys win)', async () => {
    const { fake, captured } = startFakeUpstream(() => ({
      status: 200,
      body: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    await configureEndpoints([
      {
        id: 'ep-d',
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${fakePort}/v1`,
        defaultRequestFields: { chat_template_kwargs: { enable_thinking: false, extra_default: 'from-default' } },
      },
    ]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          model: 'ep-d/some-model',
          messages: [{ role: 'user', content: 'hi' }],
          chat_template_kwargs: { enable_thinking: true },
        },
      });
      expect(res.status).toBe(200);
      const outbound = JSON.parse(captured.body!);
      // Client's enable_thinking:true wins over the default's false; the
      // default-only key (extra_default) still comes through.
      expect(outbound.chat_template_kwargs).toEqual({ enable_thinking: true, extra_default: 'from-default' });
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('an arbitrary top-level defaultRequestFields field (not just chat_template_kwargs) merges UNDER the client, client wins', async () => {
    const { fake, captured } = startFakeUpstream(() => ({
      status: 200,
      body: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    await configureEndpoints([
      { id: 'ep-lmstudio', kind: 'openai', baseUrl: `http://127.0.0.1:${fakePort}/v1`, defaultRequestFields: { reasoning_effort: 'none' } },
    ]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'ep-lmstudio/some-model', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(captured.body!).reasoning_effort).toBe('none');

      const res2 = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'ep-lmstudio/some-model', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' },
      });
      expect(res2.status).toBe(200);
      expect(JSON.parse(captured.body!).reasoning_effort).toBe('high');
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('Anthropic /v1/messages: a defaultRequestFields.reasoning_effort applies when the client sends no thinking config', async () => {
    const { fake, captured } = startFakeUpstream(() => ({
      status: 200,
      body: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    await configureEndpoints([
      { id: 'ep-lmstudio2', kind: 'openai', baseUrl: `http://127.0.0.1:${fakePort}/v1`, defaultRequestFields: { reasoning_effort: 'none' } },
    ]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'ep-lmstudio2/some-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(captured.body!).reasoning_effort).toBe('none');
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('Anthropic /v1/messages: an explicit thinking:{type:"enabled"} withholds the defaultRequestFields.reasoning_effort', async () => {
    const { fake, captured } = startFakeUpstream(() => ({
      status: 200,
      body: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    await configureEndpoints([
      { id: 'ep-lmstudio3', kind: 'openai', baseUrl: `http://127.0.0.1:${fakePort}/v1`, defaultRequestFields: { reasoning_effort: 'none' } },
    ]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          model: 'ep-lmstudio3/some-model',
          max_tokens: 32,
          messages: [{ role: 'user', content: 'hi' }],
          thinking: { type: 'enabled', budget_tokens: 1024 },
        },
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(captured.body!).reasoning_effort).toBeUndefined();
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('GET /v1/models merges each configured endpoint\'s live models, one endpoint down does not fail the listing', async () => {
    const { fake: fakeUp } = startFakeUpstream((req) => {
      expect(req.url).toBe('/v1/models');
      return { status: 200, body: { object: 'list', data: [{ id: 'model-up-1' }, { id: 'model-up-2' }] } };
    });
    const fakeUpSrv = fakeUp.listen(0);
    const fakeUpPort = (fakeUpSrv.address() as any).port;

    await configureEndpoints([
      { id: 'ep-up', kind: 'openai', baseUrl: `http://127.0.0.1:${fakeUpPort}/v1` },
      // Nothing listening on this port — the probe must fail closed (empty
      // list) without taking down the whole /v1/models response.
      { id: 'ep-down', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1' },
    ]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/models');
      expect(res.status).toBe(200);
      const ids = res.body.data.map((m: any) => m.id);
      expect(ids).toContain('ep-up/model-up-1');
      expect(ids).toContain('ep-up/model-up-2');
      expect(ids.some((id: string) => id.startsWith('ep-down/'))).toBe(false);
    } finally {
      srv.close();
      fakeUpSrv.close();
    }
  });

  it('GET /v1/endpoints reports reachability, models, and baseUrl (never a credential) per endpoint', async () => {
    const { fake: fakeUp } = startFakeUpstream(() => ({
      status: 200,
      body: { object: 'list', data: [{ id: 'model-1' }] },
    }));
    const fakeUpSrv = fakeUp.listen(0);
    const fakeUpPort = (fakeUpSrv.address() as any).port;

    await configureEndpoints([
      { id: 'ep-health-up', kind: 'openai', baseUrl: `http://127.0.0.1:${fakeUpPort}/v1`, apiKeyEnv: 'EP_HEALTH_KEY' },
      { id: 'ep-health-down', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1' },
    ]);
    process.env.EP_HEALTH_KEY = 'should-never-appear';

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/endpoints');
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(res.body.data.map((e: any) => [e.id, e]));
      expect(byId['ep-health-up'].reachable).toBe(true);
      expect(byId['ep-health-up'].models).toEqual(['model-1']);
      expect(byId['ep-health-up'].baseUrl).toBe(`http://127.0.0.1:${fakeUpPort}/v1`);
      expect(byId['ep-health-down'].reachable).toBe(false);
      expect(byId['ep-health-down'].models).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain('should-never-appear');
    } finally {
      delete process.env.EP_HEALTH_KEY;
      srv.close();
      fakeUpSrv.close();
    }
  });

  it('a reasoning_content-only upstream response surfaces a thinking block instead of an empty message', async () => {
    const { fake } = startFakeUpstream(() => ({
      status: 200,
      body: {
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'thinking really hard...' }, finish_reason: 'length' }],
        usage: {},
      },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    await configureEndpoints([{ id: 'ep-reasoning', kind: 'openai', baseUrl: `http://127.0.0.1:${fakePort}/v1` }]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'ep-reasoning/some-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(res.body.content).toEqual([{ type: 'thinking', thinking: 'thinking really hard...', signature: '' }]);
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });
});
