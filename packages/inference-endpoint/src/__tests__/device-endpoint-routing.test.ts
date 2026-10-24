/**
 * `<endpointId>@<device>` model routing (DEVICES-PLAN item 2) — a paired
 * HOST's own inference endpoint, addressed transparently through THIS
 * sidecar's daemon-callback env (`LLM_ENDPOINT_DAEMON_URL` /
 * `LLM_ENDPOINT_DAEMON_TOKEN`, injected by
 * `packages/runtime/src/llm-endpoint-registry.ts`). The fake "daemon" below
 * stands in for the real `POST /devices/:id/exec-stream/<subpath>` route
 * (`packages/runtime/src/http-server.ts`'s `handleDevices`) — these tests
 * only exercise llm-endpoint's OWN request-building, not that route itself
 * (covered separately in `packages/runtime/src/__tests__`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server, type IncomingMessage } from 'http';

const { server } = await import('../index.js');

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

/** Fake daemon — stands in for `POST /devices/:id/exec-stream/<subpath>`. */
function startFakeDaemon(handler: (req: IncomingMessage, body: string) => { status: number; body: unknown }) {
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

const SAVED_DAEMON_URL = process.env.LLM_ENDPOINT_DAEMON_URL;
const SAVED_DAEMON_TOKEN = process.env.LLM_ENDPOINT_DAEMON_TOKEN;

beforeEach(() => {
  delete process.env.LLM_ENDPOINT_DAEMON_URL;
  delete process.env.LLM_ENDPOINT_DAEMON_TOKEN;
});

afterEach(() => {
  if (SAVED_DAEMON_URL === undefined) delete process.env.LLM_ENDPOINT_DAEMON_URL;
  else process.env.LLM_ENDPOINT_DAEMON_URL = SAVED_DAEMON_URL;
  if (SAVED_DAEMON_TOKEN === undefined) delete process.env.LLM_ENDPOINT_DAEMON_TOKEN;
  else process.env.LLM_ENDPOINT_DAEMON_TOKEN = SAVED_DAEMON_TOKEN;
});

describe('device-inference routing — "<endpointId>@<device>"', () => {
  it('/v1/chat/completions: forwards to the daemon exec-stream path, rewrites model, sends the forward-method header + bearer', async () => {
    const { fake, captured } = startFakeDaemon(() => ({
      status: 200,
      body: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hi from work-mac' }, finish_reason: 'stop' }], usage: {} },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    process.env.LLM_ENDPOINT_DAEMON_URL = `http://127.0.0.1:${fakePort}`;
    process.env.LLM_ENDPOINT_DAEMON_TOKEN = 'daemon-bearer-xyz';

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'ollama@work-mac/llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(captured.path).toBe('/devices/work-mac/exec-stream/device-inference/v1/chat/completions');
      expect(captured.headers?.['x-agentproto-forward-method']).toBe('POST');
      expect(captured.headers?.authorization).toBe('Bearer daemon-bearer-xyz');
      expect(JSON.parse(captured.body!).model).toBe('ollama/llama3.1:8b');
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('/v1/messages: same device routing, request adapted to OpenAI shape, response adapted back to Anthropic', async () => {
    const { fake, captured } = startFakeDaemon(() => ({
      status: 200,
      body: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hello via device' }, finish_reason: 'stop' }], usage: {} },
    }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    process.env.LLM_ENDPOINT_DAEMON_URL = `http://127.0.0.1:${fakePort}`;
    process.env.LLM_ENDPOINT_DAEMON_TOKEN = 'daemon-bearer-xyz';

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'lmstudio@work-mac/bonsai-27b', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(captured.path).toBe('/devices/work-mac/exec-stream/device-inference/v1/chat/completions');
      expect(captured.headers?.['x-agentproto-forward-method']).toBe('POST');
      expect(captured.headers?.authorization).toBe('Bearer daemon-bearer-xyz');
      expect(JSON.parse(captured.body!).model).toBe('lmstudio/bonsai-27b');
      expect(res.body.role).toBe('assistant');
      expect(res.body.content).toEqual([{ type: 'text', text: 'hello via device' }]);
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });

  it('with LLM_ENDPOINT_DAEMON_URL unset (standalone, not daemon-managed), a device reference 400s with a clear message', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'ollama@work-mac/llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/LLM_ENDPOINT_DAEMON_URL/);
    } finally {
      srv.close();
    }
  });

  it('with LLM_ENDPOINT_DAEMON_URL set but LLM_ENDPOINT_DAEMON_TOKEN unset, 401s rather than forwarding with no bearer', async () => {
    const { fake, captured } = startFakeDaemon(() => ({ status: 200, body: {} }));
    const fakeSrv = fake.listen(0);
    const fakePort = (fakeSrv.address() as any).port;
    process.env.LLM_ENDPOINT_DAEMON_URL = `http://127.0.0.1:${fakePort}`;

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpJson(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'ollama@work-mac/llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(401);
      expect(captured.path).toBeUndefined();
    } finally {
      srv.close();
      fakeSrv.close();
    }
  });
});
