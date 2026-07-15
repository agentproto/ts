import { describe, it, expect, vi, afterEach } from 'vitest';
import { request } from 'http';
import { Readable } from 'stream';
import { IncomingMessage } from 'http';
import { resolveModelRoute, type ModelRouteContext } from '../index.js';
import { defaultPack } from '../packs.js';

const httpsMock = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('https', () => ({
  default: { request: httpsMock.request },
  request: httpsMock.request,
}));

// Set dummy upstream keys so the proxy does not short-circuit with 401.
process.env.MOONSHOT_API_KEY = 'test-moonshot';
process.env.OPENROUTER_API_KEY = 'test-openrouter';
process.env.ZAI_API_KEY = 'test-zai';
process.env.GROQ_API_KEY = 'test-groq';
process.env.XAI_API_KEY = 'test-xai';
process.env.OPENAI_API_KEY = 'test-openai';

const { server } = await import('../index.js');

function httpRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: any } = {}
): Promise<{ status: number; body: any; headers: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: 'localhost', port, path, method: options.method || 'GET', headers: options.headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(data), headers: res.headers, raw: data });
          } catch {
            resolve({ status: res.statusCode || 0, body: data, headers: res.headers, raw: data });
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

function collectEvents(raw: string): Array<{ event: string; data: any }> {
  const events: Array<{ event: string; data: any }> = [];
  const blocks = raw.split(/\r?\n\r?\n/).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let event = '';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (data) events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

function getUpstreamCall() {
  const call = httpsMock.request.mock.calls.at(-1)!;
  const options = call[0] as any;
  const result = httpsMock.request.mock.results.at(-1)!;
  const clientRequest = result.value as any;
  const writeBody = clientRequest.write.mock.calls.at(-1)?.[0] as string;
  return { options, writeBody };
}

describe('Responses facade', () => {
  afterEach(() => {
    httpsMock.request.mockReset();
  });

  it('POST /v1/responses forwards a translated chat/completions request', async () => {
    const upstreamBody = JSON.stringify({
      id: 'chatcmpl-test',
      choices: [{ message: { role: 'assistant', content: 'Hello from Moonshot' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    mockUpstreamOnce([upstreamBody]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'moonshot/kimi-k2.7-code', input: 'Say hello' },
      });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body.object).toBe('response');
      expect(res.body.model).toBe('moonshot/kimi-k2.7-code');
      expect(res.body.output).toHaveLength(1);
      expect(res.body.output[0].content[0].text).toBe('Hello from Moonshot');

      expect(httpsMock.request).toHaveBeenCalledTimes(1);
      const { options: callOptions, writeBody } = getUpstreamCall();
      expect(callOptions.hostname).toBe('api.moonshot.ai');
      expect(callOptions.path).toBe('/v1/chat/completions');
      expect(callOptions.method).toBe('POST');
      expect(callOptions.headers['Authorization']).toBe('Bearer test-moonshot');

      const forwardedBody = JSON.parse(writeBody);
      expect(forwardedBody.model).toBe('kimi-k2.7-code');
      expect(forwardedBody.messages).toEqual([{ role: 'user', content: 'Say hello' }]);
    } finally {
      srv.close();
    }
  });

  it('POST /v1/chat/completions forwards transparently without Responses conversion', async () => {
    mockUpstreamOnce([
      JSON.stringify({
        id: 'chatcmpl-chat',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
    ]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('ok');
      const { options: callOptions, writeBody } = getUpstreamCall();
      expect(callOptions.hostname).toBe('api.openai.com');
      expect(callOptions.path).toBe('/v1/chat/completions');
      expect(callOptions.headers['Authorization']).toBe('Bearer test-openai');
      const forwardedBody = JSON.parse(writeBody);
      expect(forwardedBody.model).toBe('gpt-4o');
      expect(forwardedBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
    } finally {
      srv.close();
    }
  });

  it('routes direct OpenAI Responses calls to api.openai.com', async () => {
    mockUpstreamOnce([
      JSON.stringify({
        id: 'chatcmpl-openai',
        choices: [{ message: { role: 'assistant', content: 'Hello from OpenAI' } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
    ]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'openai/gpt-4.1', input: 'hi' },
      });

      expect(res.status).toBe(200);
      expect(res.body.model).toBe('openai/gpt-4.1');
      const { options: callOptions, writeBody } = getUpstreamCall();
      expect(callOptions.hostname).toBe('api.openai.com');
      expect(callOptions.path).toBe('/v1/chat/completions');
      expect(callOptions.headers['Authorization']).toBe('Bearer test-openai');
      const forwardedBody = JSON.parse(writeBody);
      expect(forwardedBody.model).toBe('gpt-4.1');
    } finally {
      srv.close();
    }
  });

  it('routes /v1/{pack}/responses using transparent references, not alias codes', async () => {
    mockUpstreamOnce([
      JSON.stringify({
        id: 'chatcmpl-xai',
        choices: [{ message: { role: 'assistant', content: 'greetings' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
    ]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/xai/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'xai/grok-4.5', input: 'hi' },
      });

      expect(res.status).toBe(200);
      const { options: callOptions, writeBody } = getUpstreamCall();
      expect(callOptions.hostname).toBe('api.x.ai');
      expect(callOptions.path).toBe('/v1/chat/completions');
      expect(callOptions.headers['Authorization']).toBe('Bearer test-xai');
      const forwardedBody = JSON.parse(writeBody);
      expect(forwardedBody.model).toBe('grok-4.5');
    } finally {
      srv.close();
    }
  });

  it('?p= provider override changes the upstream endpoint', async () => {
    mockUpstreamOnce([
      JSON.stringify({
        id: 'chatcmpl-groq',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    ]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/responses?p=groq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'llama-3.3-70b-versatile', input: 'hi' },
      });

      expect(res.status).toBe(200);
      const { options: callOptions, writeBody } = getUpstreamCall();
      expect(callOptions.hostname).toBe('api.groq.com');
      expect(callOptions.path).toBe('/openai/v1/chat/completions');
      const forwardedBody = JSON.parse(writeBody);
      expect(forwardedBody.model).toBe('llama-3.3-70b-versatile');
    } finally {
      srv.close();
    }
  });

  it('translates a tool call response back to Responses API items', async () => {
    mockUpstreamOnce([
      JSON.stringify({
        id: 'chatcmpl-tool',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      }),
    ]);

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          model: 'moonshot/kimi-k2.7-code',
          input: 'weather?',
          tools: [{ type: 'function', name: 'get_weather' }],
        },
      });

      expect(res.status).toBe(200);
      const items = res.body.output;
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('function_call');
      expect(items[0].name).toBe('get_weather');
      expect(items[0].arguments).toBe('{"city":"Paris"}');

      const forwardedBody = JSON.parse(getUpstreamCall().writeBody);
      expect(forwardedBody.tools).toEqual([
        { type: 'function', function: { name: 'get_weather' } },
      ]);
    } finally {
      srv.close();
    }
  });

  it('streams chat/completions SSE into Responses API SSE events', async () => {
    const sseChunks = [
      'data: ' +
        JSON.stringify({
          id: 'chatcmpl-stream',
          choices: [{ delta: { role: 'assistant', content: 'Hello' } }],
        }) +
        '\n\n',
      'data: ' +
        JSON.stringify({
          id: 'chatcmpl-stream',
          choices: [{ delta: { content: ' world' } }],
        }) +
        '\n\n',
      'data: [DONE]\n\n',
    ];
    mockUpstreamOnce(sseChunks, 200, { 'content-type': 'text/event-stream' });

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'moonshot/kimi-k2.7-code', input: 'Say hello', stream: true },
      });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      const events = collectEvents(res.raw);
      const types = events.map((e) => e.event);
      expect(types).toContain('response.created');
      expect(types).toContain('response.output_text.delta');
      expect(types).toContain('response.completed');

      const deltas = events
        .filter((e) => e.event === 'response.output_text.delta')
        .map((e) => e.data.delta);
      expect(deltas).toEqual(['Hello', ' world']);
    } finally {
      srv.close();
    }
  });

  it('rejects previous_response_id', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'moonshot/kimi-k2.7-code', input: 'hi', previous_response_id: 'resp_123' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('previous_response_id');
    } finally {
      srv.close();
    }
  });

  it('rejects structured output text.format', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'moonshot/kimi-k2.7-code', input: 'hi', text: { format: { type: 'json_object' } } },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('text.format');
    } finally {
      srv.close();
    }
  });

  it('rejects unsupported input item types', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'moonshot/kimi-k2.7-code', input: [{ type: 'image' }] },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('input item type');
    } finally {
      srv.close();
    }
  });

  it('rejects unsupported tool types', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'moonshot/kimi-k2.7-code', input: 'hi', tools: [{ type: 'web_search' }] },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('tool type');
    } finally {
      srv.close();
    }
  });

  it('passes through upstream errors', async () => {
    mockUpstreamOnce(
      [JSON.stringify({ error: { message: 'model not found', type: 'invalid_request_error' } })],
      400
    );

    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'moonshot/kimi-k2.7-code', input: 'hi' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('model not found');
    } finally {
      srv.close();
    }
  });

  it('returns 400 for an unknown provider override', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/responses?p=unknown-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'moonshot/kimi-k2.7-code', input: 'hi' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Unknown provider');
    } finally {
      srv.close();
    }
  });

  it('returns 400 for a bare model id without provider prefix or ?p=', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'kimi-k2.7-code', input: 'hi' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Unable to resolve model');
    } finally {
      srv.close();
    }
  });
});

describe('resolveModelRoute', () => {
  const baseCtx: ModelRouteContext = {
    activePack: defaultPack,
    queryModelCode: null,
    queryProvider: null,
    forcedAliasCode: null,
    allowAliases: false,
  };

  it('resolves transparent provider/model references', () => {
    expect(resolveModelRoute({ model: 'moonshot/kimi-k2.7-code' }, baseCtx, {})).toEqual({
      provider: 'moonshot',
      model: 'kimi-k2.7-code',
    });
  });

  it('normalizes direct OpenAI references', () => {
    expect(resolveModelRoute({ model: 'openai/gpt-4.1' }, baseCtx, {})).toEqual({
      provider: 'openai',
      model: 'gpt-4.1',
    });
  });

  it('applies ?p= provider override', () => {
    expect(
      resolveModelRoute({ model: 'gpt-4.1' }, { ...baseCtx, queryProvider: 'openai' }, {})
    ).toEqual({ provider: 'openai', model: 'gpt-4.1' });
  });

  it('resolves pack codes on the Messages path', () => {
    expect(
      resolveModelRoute({ model: 'kimi-k2.7-code' }, { ...baseCtx, allowAliases: true }, {})
    ).toEqual({ provider: 'moonshot', model: 'kimi-k2.7-code' });
  });

  it('resolves local-pack Claude aliases only when explicitly selected', () => {
    const localPack = {
      id: 'local-claude',
      label: 'Local Claude compat',
      description: '',
      models: {
        'my-opus': {
          provider: 'moonshot',
          model: 'kimi-k2.7-code',
          equivalentClaudeName: 'claude-opus-4-8',
        },
      },
    };

    // Messages path with the local pack selected can use the Claude alias.
    expect(
      resolveModelRoute(
        { model: 'claude-opus-4-8' },
        { ...baseCtx, activePack: localPack, allowAliases: true },
        { 'local-claude': localPack }
      )
    ).toEqual({ provider: 'moonshot', model: 'kimi-k2.7-code' });

    // The same alias is NOT resolvable on transparent surfaces.
    expect(() =>
      resolveModelRoute(
        { model: 'claude-opus-4-8' },
        { ...baseCtx, activePack: localPack, allowAliases: false },
        { 'local-claude': localPack }
      )
    ).toThrow(/Unable to resolve model/);

    // And it is not resolvable on the Messages path unless the local pack is active.
    expect(() =>
      resolveModelRoute(
        { model: 'claude-opus-4-8' },
        { ...baseCtx, allowAliases: true },
        {}
      )
    ).toThrow(/Unable to resolve model/);
  });

  it('rejects unknown providers in transparent references', () => {
    expect(() => resolveModelRoute({ model: 'fake/model' }, baseCtx, {})).toThrow(/Unable to resolve model/);
  });
});
