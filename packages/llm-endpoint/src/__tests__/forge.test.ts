import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server, type IncomingMessage } from 'http';
import { parseTransparentModel } from '../packs.js';

const { resolveForgeBaseUrl, server } = await import('../index.js');

// ── env isolation ────────────────────────────────────────────────────────
// FORGE_BASE_URL / FORGE_API_KEY are mutated per-test (unlike proxy.test.ts's
// always-on dummy keys, "not configured" is itself a case under test here),
// so every test snapshots and restores them — mirrors upstream-credential.test.ts.
const TOUCHED_ENV = ['FORGE_BASE_URL', 'FORGE_API_KEY'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(TOUCHED_ENV.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED_ENV) delete process.env[k];
});

afterEach(() => {
  for (const k of TOUCHED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── parseTransparentModel("forge/<model>") ──────────────────────────────────

describe('parseTransparentModel — forge', () => {
  it('parses "forge/<model>" into {provider:"forge", model}', () => {
    expect(parseTransparentModel('forge/my-lora-v3')).toEqual({ provider: 'forge', model: 'my-lora-v3' });
  });

  it('keeps only the first slash as the provider separator', () => {
    expect(parseTransparentModel('forge/team/my-lora-v3')).toEqual({ provider: 'forge', model: 'team/my-lora-v3' });
  });

  it('rejects an unknown provider prefix', () => {
    expect(parseTransparentModel('not-forge/my-lora-v3')).toBeNull();
  });
});

// ── resolveForgeBaseUrl — URL parsing with port + scheme ────────────────────

describe('resolveForgeBaseUrl', () => {
  it('returns null when unset', () => {
    expect(resolveForgeBaseUrl(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(resolveForgeBaseUrl('')).toBeNull();
  });

  it('parses http + explicit port + path prefix', () => {
    expect(resolveForgeBaseUrl('http://10.0.10.20:8000/v1')).toEqual({
      hostname: '10.0.10.20',
      port: 8000,
      protocol: 'http',
      pathPrefix: '/v1',
    });
  });

  it('parses https, defaulting the port to 443 when omitted', () => {
    expect(resolveForgeBaseUrl('https://forge.internal/v1')).toEqual({
      hostname: 'forge.internal',
      port: 443,
      protocol: 'https',
      pathPrefix: '/v1',
    });
  });

  it('defaults the port to 80 for http when omitted', () => {
    expect(resolveForgeBaseUrl('http://forge.internal')).toEqual({
      hostname: 'forge.internal',
      port: 80,
      protocol: 'http',
      pathPrefix: '',
    });
  });

  it('strips a trailing slash from the path prefix', () => {
    expect(resolveForgeBaseUrl('http://10.0.10.20:8000/v1/')?.pathPrefix).toBe('/v1');
  });

  it('returns null for a malformed URL', () => {
    expect(resolveForgeBaseUrl('not-a-url')).toBeNull();
  });

  it('returns null for a non-http(s) scheme', () => {
    expect(resolveForgeBaseUrl('ftp://10.0.10.20:8000/v1')).toBeNull();
  });
});

// ── HTTP integration — local ephemeral "forge" upstream, no real network ───

describe('forge provider — HTTP integration', () => {
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

  /** Spin up a fake vLLM-style OpenAI-compatible server and capture what it received. */
  function startFakeForgeUpstream(handler: (req: IncomingMessage, body: string) => { status: number; body: unknown }) {
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

  it('provider not configured (no FORGE_BASE_URL) → 4xx on /v1/chat/completions, not a crash', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'forge/my-lora', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.body.error.message).toContain('forge provider not configured');
    } finally {
      srv.close();
    }
  });

  it('provider not configured (no FORGE_BASE_URL) → 4xx on /v1/messages, not a crash', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'forge/my-lora', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.body.error.message).toContain('forge provider not configured');
    } finally {
      srv.close();
    }
  });

  it('provider not configured (no FORGE_BASE_URL) → 4xx on /v1/responses, not a crash', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'forge/my-lora', input: 'hi' },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.body.error.message).toContain('forge provider not configured');
    } finally {
      srv.close();
    }
  });

  it('no FORGE_API_KEY set → forwards the request with no Authorization header', async () => {
    const { fake, captured } = startFakeForgeUpstream(() => ({
      status: 200,
      body: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: {} },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    process.env.FORGE_BASE_URL = `http://127.0.0.1:${fakePort}/v1`;

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'forge/my-lora', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(captured.path).toBe('/v1/chat/completions');
      expect(captured.headers?.authorization).toBeUndefined();
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('FORGE_API_KEY set → forwards Authorization: Bearer <key>', async () => {
    const { fake, captured } = startFakeForgeUpstream(() => ({
      status: 200,
      body: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: {} },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    process.env.FORGE_BASE_URL = `http://127.0.0.1:${fakePort}/v1`;
    process.env.FORGE_API_KEY = 'secret-forge-key';

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'forge/my-lora', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(captured.headers?.authorization).toBe('Bearer secret-forge-key');
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('routes /v1/messages (Anthropic surface) through forge, translating request + response', async () => {
    const { fake, captured } = startFakeForgeUpstream(() => ({
      status: 200,
      body: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hello from forge' }, finish_reason: 'stop' }], usage: {} },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    process.env.FORGE_BASE_URL = `http://127.0.0.1:${fakePort}/v1`;

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'forge/my-lora', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(captured.path).toBe('/v1/chat/completions');
      expect(captured.headers?.authorization).toBeUndefined();
      const outboundBody = JSON.parse(captured.body!);
      expect(outboundBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
      // Anthropic-shaped response, translated back from the OpenAI-shaped upstream body.
      expect(res.body.role).toBe('assistant');
      expect(res.body.content).toEqual([{ type: 'text', text: 'hello from forge' }]);
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('GET /v1/models merges live forge models, prefixed with "forge/"', async () => {
    const { fake } = startFakeForgeUpstream((req) => {
      expect(req.url).toBe('/v1/models');
      return { status: 200, body: { object: 'list', data: [{ id: 'my-lora-v3', object: 'model' }] } };
    });
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    process.env.FORGE_BASE_URL = `http://127.0.0.1:${fakePort}/v1`;

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/models');
      expect(res.status).toBe(200);
      const ids = res.body.data.map((m: any) => m.id);
      expect(ids).toContain('forge/my-lora-v3');
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('GET /v1/models omits forge entries when FORGE_BASE_URL is unset', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/models');
      expect(res.status).toBe(200);
      const ids = res.body.data.map((m: any) => m.id);
      expect(ids.some((id: string) => id.startsWith('forge/'))).toBe(false);
    } finally {
      srv.close();
    }
  });

  it('GET /v1/xai/models is unaffected by forge (pack-scoped, not merged)', async () => {
    const { fake } = startFakeForgeUpstream(() => ({
      status: 200,
      body: { object: 'list', data: [{ id: 'my-lora-v3', object: 'model' }] },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    process.env.FORGE_BASE_URL = `http://127.0.0.1:${fakePort}/v1`;

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/xai/models');
      expect(res.status).toBe(200);
      const ids = res.body.data.map((m: any) => m.id);
      expect(ids.some((id: string) => id.startsWith('forge/'))).toBe(false);
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });
});
