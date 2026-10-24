import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'http';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Proves the real wiring gap is closed: a key set via
// `agentproto auth provider set` (present in ~/.agentproto/providers.json,
// absent from process.env) reaches llm-endpoint's request handling, exactly
// the way cli.ts's boot-time `injectProviderKeysIntoEnv(process.env)` call
// feeds it. Uses a temp HOME so the real providers.json is never read,
// written, or touched.

const httpsMock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('https', () => ({
  default: { request: httpsMock.request },
  request: httpsMock.request,
}));

const { server } = await import('../index.js');
const { setProviderKey, injectProviderKeysIntoEnv } = await import('@agentproto/providers-store');

function httpRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: any } = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: 'localhost', port, path, method: options.method || 'GET', headers: options.headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 0, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

function makeIncomingMessage(opts: {
  statusCode?: number;
  headers?: Record<string, string>;
  chunks?: string[];
}): IncomingMessage {
  const msg = new Readable({ read() {} }) as IncomingMessage;
  msg.statusCode = opts.statusCode ?? 200;
  msg.headers = opts.headers ?? {};
  process.nextTick(() => {
    for (const chunk of opts.chunks ?? []) msg.push(chunk);
    msg.push(null);
  });
  return msg;
}

function mockUpstreamOnce(
  chunks: string[],
  statusCode = 200,
  headers: Record<string, string> = { 'content-type': 'application/json' }
) {
  httpsMock.request.mockImplementation((_options: any, callback?: any) => {
    const msg = makeIncomingMessage({ statusCode, headers, chunks });
    if (typeof callback === 'function') callback(msg);
    return { write: vi.fn(), end: vi.fn(), on: vi.fn() } as any;
  });
}

function getUpstreamCallOptions() {
  const call = httpsMock.request.mock.calls.at(-1)!;
  return call[0] as any;
}

let prevHome: string | undefined;
let prevXaiKey: string | undefined;
let home: string;

beforeEach(async () => {
  prevHome = process.env.HOME;
  prevXaiKey = process.env.XAI_API_KEY;
  delete process.env.XAI_API_KEY; // absent from env — must come from the store
  home = await mkdtemp(join(tmpdir(), 'llm-endpoint-prov-'));
  process.env.HOME = home;
  httpsMock.request.mockReset();
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevXaiKey === undefined) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = prevXaiKey;
  await rm(home, { recursive: true, force: true });
});

describe('llm-endpoint resolves keys from the provider store at boot', () => {
  it('401s a provider with no key in env or store', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'xai/grok-test', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('No API key for provider "xai"');
      expect(httpsMock.request).not.toHaveBeenCalled();
    } finally {
      srv.close();
    }
  });

  it('resolves a key set via `agentproto auth provider set` — present in the store, absent from env', async () => {
    await setProviderKey('xai', 'sk-fake-store-key-do-not-use');
    const injected = await injectProviderKeysIntoEnv(process.env);
    expect(injected).toContain('xai');
    expect(process.env.XAI_API_KEY).toBe('sk-fake-store-key-do-not-use');

    mockUpstreamOnce([
      JSON.stringify({
        id: 'chatcmpl-test',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    ]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'xai/grok-test', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).not.toBe(401);
      expect(httpsMock.request).toHaveBeenCalledTimes(1);
      const callOptions = getUpstreamCallOptions();
      expect(callOptions.hostname).toBe('api.x.ai');
      expect(callOptions.headers['Authorization']).toBe('Bearer sk-fake-store-key-do-not-use');
    } finally {
      srv.close();
    }
  });

  it('explicit env still wins over the store', async () => {
    process.env.XAI_API_KEY = 'sk-explicit-env-wins';
    await setProviderKey('xai', 'sk-from-store-should-not-be-used');
    const injected = await injectProviderKeysIntoEnv(process.env);
    expect(injected).not.toContain('xai');
    expect(process.env.XAI_API_KEY).toBe('sk-explicit-env-wins');

    mockUpstreamOnce([
      JSON.stringify({
        id: 'chatcmpl-test2',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: {},
      }),
    ]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      await httpRequest(port, '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'xai/grok-test', messages: [{ role: 'user', content: 'hi' }] },
      });
      const callOptions = getUpstreamCallOptions();
      expect(callOptions.headers['Authorization']).toBe('Bearer sk-explicit-env-wins');
    } finally {
      srv.close();
    }
  });

  it('boot does not hard-fail when providers.json is absent (fresh install)', async () => {
    await expect(injectProviderKeysIntoEnv(process.env)).resolves.toEqual([]);
  });
});
