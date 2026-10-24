import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server, type IncomingMessage } from 'http';
import { parseTransparentModel } from '../packs.js';

const { resolveNebiusBaseUrl, server } = await import('../index.js');

// ── env isolation ────────────────────────────────────────────────────────
// NEBIUS_BASE_URL / NEBIUS_API_KEY are mutated per-test — mirrors forge.test.ts.
const TOUCHED_ENV = ['NEBIUS_BASE_URL', 'NEBIUS_API_KEY'];
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

// ── parseTransparentModel("nebius/<model>") ─────────────────────────────────

describe('parseTransparentModel — nebius', () => {
  it('parses "nebius/<model>" into {provider:"nebius", model}', () => {
    expect(parseTransparentModel('nebius/meta-llama/Llama-3.1-8B-Instruct')).toEqual({
      provider: 'nebius',
      model: 'meta-llama/Llama-3.1-8B-Instruct',
    });
  });

  it('passes a fine-tune id through verbatim', () => {
    expect(parseTransparentModel('nebius/ft:meta-llama/Llama-3.1-8B-Instruct:my-job:abc123')).toEqual({
      provider: 'nebius',
      model: 'ft:meta-llama/Llama-3.1-8B-Instruct:my-job:abc123',
    });
  });
});

// ── resolveNebiusBaseUrl — default host + override parsing ─────────────────

describe('resolveNebiusBaseUrl', () => {
  it('defaults to the public Nebius AI Studio endpoint when unset', () => {
    expect(resolveNebiusBaseUrl(undefined)).toEqual({
      hostname: 'api.studio.nebius.com',
      port: 443,
      protocol: 'https',
      pathPrefix: '/v1',
    });
  });

  it('defaults when the env var is an empty string', () => {
    expect(resolveNebiusBaseUrl('')).toEqual({
      hostname: 'api.studio.nebius.com',
      port: 443,
      protocol: 'https',
      pathPrefix: '/v1',
    });
  });

  it('honours a NEBIUS_BASE_URL override (dedicated endpoint, different host + port)', () => {
    expect(resolveNebiusBaseUrl('https://my-dedicated-endpoint.eu.nebius.cloud:9000/v1')).toEqual({
      hostname: 'my-dedicated-endpoint.eu.nebius.cloud',
      port: 9000,
      protocol: 'https',
      pathPrefix: '/v1',
    });
  });

  it('returns null for a malformed override (does NOT silently fall back to the default)', () => {
    expect(resolveNebiusBaseUrl('not-a-url')).toBeNull();
  });

  it('returns null for a non-http(s) override scheme', () => {
    expect(resolveNebiusBaseUrl('ftp://my-dedicated-endpoint.eu.nebius.cloud/v1')).toBeNull();
  });
});

// ── HTTP integration — local ephemeral "nebius" upstream, no real network ──

describe('nebius provider — HTTP integration', () => {
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

  /** Spin up a fake OpenAI-compatible server (standing in for Nebius) and capture what it received. */
  function startFakeNebiusUpstream(handler: (req: IncomingMessage, body: string) => { status: number; body: unknown }) {
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

  it('missing NEBIUS_API_KEY → 401 with the same error shape as every other provider', async () => {
    const { fake } = startFakeNebiusUpstream(() => ({ status: 200, body: {} }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    // Point the default host at the local fake so a would-be network call
    // never actually leaves the box even if the 401 check is broken.
    process.env.NEBIUS_BASE_URL = `http://127.0.0.1:${fakePort}/v1`;

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'nebius/meta-llama/Llama-3.1-8B-Instruct', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('No API key for provider "nebius"');
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('routes nebius/<model> to the configured host with Authorization: Bearer <NEBIUS_API_KEY>', async () => {
    const { fake, captured } = startFakeNebiusUpstream(() => ({
      status: 200,
      body: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: {} },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    process.env.NEBIUS_BASE_URL = `http://127.0.0.1:${fakePort}/v1`;
    process.env.NEBIUS_API_KEY = 'secret-nebius-key';

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'nebius/meta-llama/Llama-3.1-8B-Instruct', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(captured.path).toBe('/v1/chat/completions');
      expect(captured.headers?.authorization).toBe('Bearer secret-nebius-key');
      const outboundBody = JSON.parse(captured.body!);
      expect(outboundBody.model).toBe('meta-llama/Llama-3.1-8B-Instruct');
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('NEBIUS_BASE_URL override is honoured end-to-end (dedicated-endpoint style host)', async () => {
    const { fake, captured } = startFakeNebiusUpstream(() => ({
      status: 200,
      body: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: {} },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    // A different path prefix than the default "/v1", to prove the override's
    // pathPrefix (not a hardcoded "/v1") is what gets used.
    process.env.NEBIUS_BASE_URL = `http://127.0.0.1:${fakePort}/dedicated/v1`;
    process.env.NEBIUS_API_KEY = 'secret-nebius-key';

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'nebius/meta-llama/Llama-3.1-8B-Instruct', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(captured.path).toBe('/dedicated/v1/chat/completions');
      expect(res.body.role).toBe('assistant');
      expect(res.body.content).toEqual([{ type: 'text', text: 'hi' }]);
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('provider-not-configured 4xx never applies to nebius (it has a working default)', async () => {
    // No NEBIUS_BASE_URL, no NEBIUS_API_KEY at all — nebius should still
    // resolve an endpoint (the public default) and 401 on the missing key,
    // never a "not configured" 400 like forge would.
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'nebius/meta-llama/Llama-3.1-8B-Instruct', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('No API key for provider "nebius"');
    } finally {
      srv.close();
    }
  });
});
