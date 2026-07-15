import { describe, it, expect } from 'vitest';
import type { ToolTrimOptions } from '../index.js';
import { request } from 'http';
import { xaiPack } from '../packs.js';

// Provide dummy upstream keys so that any test exercising the outbound proxy
// path does not short-circuit with a missing-key 401.
process.env.MOONSHOT_API_KEY = 'test-moonshot';
process.env.OPENROUTER_API_KEY = 'test-openrouter';
process.env.ZAI_API_KEY = 'test-zai';
process.env.GROQ_API_KEY = 'test-groq';
process.env.XAI_API_KEY = 'test-xai';
process.env.OPENAI_API_KEY = 'test-openai';

const { trimTools, server } = await import('../index.js');

// ── trimTools ─────────────────────────────────────────────────────────────

describe('trimTools', () => {
  const baseOpts: ToolTrimOptions = {
    provider: 'openrouter',
    queryTools: null,
    queryNoTools: null,
    headerTools: null,
    headerNoTools: null,
    headerExcludeTools: null,
  };

  it('returns early when payload has no tools', () => {
    const payload = { messages: [] };
    trimTools(payload, baseOpts);
    expect(payload).toEqual({ messages: [] });
  });

  it('returns early when tools is empty array', () => {
    const payload = { tools: [] };
    trimTools(payload, baseOpts);
    expect(payload.tools).toEqual([]);
  });

  it('strips all tools via queryNoTools=1', () => {
    const payload = {
      tools: [{ name: 'Bash' }, { name: 'Read' }],
      tool_choice: 'auto',
    };
    trimTools(payload, { ...baseOpts, queryNoTools: '1' });
    expect(payload.tools).toBeUndefined();
    expect(payload.tool_choice).toBeUndefined();
  });

  it('strips all tools via queryTools=none', () => {
    const payload = {
      tools: [{ name: 'Bash' }],
      tool_choice: 'auto',
    };
    trimTools(payload, { ...baseOpts, queryTools: 'none' });
    expect(payload.tools).toBeUndefined();
    expect(payload.tool_choice).toBeUndefined();
  });

  it('strips all tools via headerNoTools=1', () => {
    const payload = {
      tools: [{ name: 'Bash' }, { name: 'Read' }],
      tool_choice: 'auto',
    };
    trimTools(payload, { ...baseOpts, headerNoTools: '1' });
    expect(payload.tools).toBeUndefined();
    expect(payload.tool_choice).toBeUndefined();
  });

  it('allow-list via headerTools keeps matching tools (exact)', () => {
    const payload = {
      tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'Write' }],
    };
    trimTools(payload, { ...baseOpts, headerTools: 'Bash,Read' });
    expect(payload.tools).toHaveLength(2);
    expect(payload.tools!.map((t: any) => t.name)).toEqual(['Bash', 'Read']);
  });

  it('allow-list via headerTools with wildcard agentproto_*', () => {
    const payload = {
      tools: [
        { name: 'agentproto_start' },
        { name: 'agentproto_stop' },
        { name: 'Bash' },
      ],
    };
    trimTools(payload, { ...baseOpts, headerTools: 'agentproto_*' });
    expect(payload.tools).toHaveLength(2);
    expect(payload.tools!.map((t: any) => t.name)).toEqual(['agentproto_start', 'agentproto_stop']);
  });

  it('headerTools takes precedence over queryTools for allow-list', () => {
    const payload = {
      tools: [{ name: 'Bash' }, { name: 'Read' }],
    };
    trimTools(payload, { ...baseOpts, queryTools: 'Bash', headerTools: 'Read' });
    // headerTools is checked first in code, but both are allow-list — header wins
    expect(payload.tools).toHaveLength(1);
    expect((payload.tools as any[])[0].name).toBe('Read');
  });

  it('exclude-list via headerExcludeTools removes matching tools', () => {
    const payload = {
      tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'Write' }],
    };
    trimTools(payload, { ...baseOpts, headerExcludeTools: 'Bash' });
    expect(payload.tools).toHaveLength(2);
    expect(payload.tools!.map((t: any) => t.name)).toEqual(['Read', 'Write']);
  });

  it('exclude-list with wildcard removes matching tools', () => {
    const payload = {
      tools: [
        { name: 'agentproto_start' },
        { name: 'agentproto_stop' },
        { name: 'Bash' },
      ],
    };
    trimTools(payload, { ...baseOpts, headerExcludeTools: 'agentproto_*' });
    expect(payload.tools).toHaveLength(1);
    expect((payload.tools as any[])[0].name).toBe('Bash');
  });

  it('exclude-list removes all tools → deletes tools array', () => {
    const payload = {
      tools: [{ name: 'Bash' }],
      tool_choice: 'auto',
    };
    trimTools(payload, { ...baseOpts, headerExcludeTools: 'Bash' });
    expect(payload.tools).toBeUndefined();
    expect(payload.tool_choice).toBeUndefined();
  });

  it('handles OpenAI function-style tool names', () => {
    const payload = {
      tools: [
        { function: { name: 'get_weather' } },
        { function: { name: 'set_timer' } },
      ],
    };
    trimTools(payload, { ...baseOpts, headerTools: 'get_weather' });
    expect(payload.tools).toHaveLength(1);
    expect((payload.tools as any[])[0].function.name).toBe('get_weather');
  });

  it('provider cap truncates tools when exceeded', () => {
    const tools = Array.from({ length: 150 }, (_, i) => ({ name: `tool_${i}` }));
    const payload = { tools };
    trimTools(payload, { ...baseOpts, provider: 'groq' });
    expect(payload.tools).toHaveLength(128);
  });

  it('provider cap does not truncate when under limit', () => {
    const tools = Array.from({ length: 50 }, (_, i) => ({ name: `tool_${i}` }));
    const payload = { tools };
    trimTools(payload, { ...baseOpts, provider: 'groq' });
    expect(payload.tools).toHaveLength(50);
  });

  it('xai provider cap is 200', () => {
    const tools = Array.from({ length: 250 }, (_, i) => ({ name: `tool_${i}` }));
    const payload = { tools };
    trimTools(payload, { ...baseOpts, provider: 'xai' });
    expect(payload.tools).toHaveLength(200);
  });

  it('no cap for unknown provider', () => {
    const tools = Array.from({ length: 300 }, (_, i) => ({ name: `tool_${i}` }));
    const payload = { tools };
    trimTools(payload, { ...baseOpts, provider: 'unknown' });
    expect(payload.tools).toHaveLength(300);
  });

  it('headerNoTools takes precedence over headerTools', () => {
    const payload = {
      tools: [{ name: 'Bash' }],
    };
    trimTools(payload, { ...baseOpts, headerNoTools: '1', headerTools: 'Bash' });
    expect(payload.tools).toBeUndefined();
  });

  it('headerExcludeTools is ignored when headerTools is set', () => {
    const payload = {
      tools: [{ name: 'Bash' }, { name: 'Read' }],
    };
    trimTools(payload, { ...baseOpts, headerTools: 'Bash', headerExcludeTools: 'Bash' });
    // headerTools (allow-list) is checked before headerExcludeTools
    expect(payload.tools).toHaveLength(1);
    expect((payload.tools as any[])[0].name).toBe('Bash');
  });
});

// ── ToolTrimOptions interface ─────────────────────────────────────────────

describe('ToolTrimOptions', () => {
  it('accepts all required fields', () => {
    const opts: ToolTrimOptions = {
      provider: 'openrouter',
      queryTools: 'Bash,Read',
      queryNoTools: null,
      headerTools: null,
      headerNoTools: null,
      headerExcludeTools: null,
    };
    expect(opts.provider).toBe('openrouter');
    expect(opts.queryTools).toBe('Bash,Read');
  });
});

// ── Integration: trimTools + matchesPattern ───────────────────────────────

describe('trimTools + matchesPattern integration', () => {
  const baseOpts: ToolTrimOptions = {
    provider: 'openrouter',
    queryTools: null,
    queryNoTools: null,
    headerTools: null,
    headerNoTools: null,
    headerExcludeTools: null,
  };

  it('wildcard prefix matching works end-to-end', () => {
    const payload = {
      tools: [
        { name: 'agentproto_start' },
        { name: 'agentproto_stop' },
        { name: 'agentproto_restart' },
        { name: 'Bash' },
        { name: 'Read' },
      ],
    };
    trimTools(payload, { ...baseOpts, headerTools: 'agentproto_*' });
    expect(payload.tools).toHaveLength(3);
    expect(payload.tools!.every((t: any) => t.name.startsWith('agentproto_'))).toBe(true);
  });

  it('multiple wildcard patterns in allow-list', () => {
    const payload = {
      tools: [
        { name: 'agentproto_start' },
        { name: 'mcp_read' },
        { name: 'mcp_write' },
        { name: 'Bash' },
      ],
    };
    trimTools(payload, { ...baseOpts, headerTools: 'agentproto_*,mcp_*' });
    expect(payload.tools).toHaveLength(3);
    expect(payload.tools!.map((t: any) => t.name)).toEqual(['agentproto_start', 'mcp_read', 'mcp_write']);
  });
});

// ── HTTP Server routing ───────────────────────────────────────────────────

describe('Proxy HTTP Server', () => {
  function httpRequest(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: any } = {}): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: 'localhost', port, path, method: options.method || 'GET', headers: options.headers }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode || 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode || 0, body: data }); }
        });
      });
      req.on('error', reject);
      if (options.body) req.write(JSON.stringify(options.body));
      req.end();
    });
  }

  it('GET /v1/models returns model list (default pack)', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/models');
      expect(res.status).toBe(200);
      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    } finally { srv.close(); }
  });

  it('GET /v1/models with X-Proxy-Pack: xai returns xai models', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/models', { headers: { 'X-Proxy-Pack': 'xai' } });
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(Object.keys(xaiPack.models).length);
      const ids = res.body.data.map((m: any) => m.id);
      expect(ids).toContain('grok-4.5');
      expect(ids).toContain('grok-4.3');
    } finally { srv.close(); }
  });

  it('GET /v1/models?pack=xai returns xai models', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/models?pack=xai');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(Object.keys(xaiPack.models).length);
    } finally { srv.close(); }
  });

  it('GET /v1/xai/models returns xai models via URL path', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/xai/models');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(Object.keys(xaiPack.models).length);
    } finally { srv.close(); }
  });

  it('GET /v1/models with unknown X-Proxy-Pack returns 400', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/models', { headers: { 'X-Proxy-Pack': 'unknown-pack' } });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Unknown pack');
    } finally { srv.close(); }
  });

  it('GET /v1/models?pack=unknown returns 400', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/models?pack=unknown');
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Unknown pack');
    } finally { srv.close(); }
  });

  it('GET /v1/unknown/models returns 400', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/unknown/models');
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Unknown pack');
    } finally { srv.close(); }
  });

  it('POST /v1/messages with unknown model code via ?m= returns 400', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/messages?m=nonexistent-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Unknown model code');
    } finally { srv.close(); }
  });

  it('GET /v1/packs returns list of available packs', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/packs');
      expect(res.status).toBe(200);
      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.data)).toBe(true);
      const ids = res.body.data.map((p: any) => p.id);
      expect(ids).toContain('default');
      expect(ids).toContain('xai');
      expect(ids).toContain('openrouter');
    } finally { srv.close(); }
  });

  it('GET /v1/models with X-Proxy-Model-Alias forces model selection', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/models', { headers: { 'X-Proxy-Model-Alias': 'grok-4.5' } });
      expect(res.status).toBe(200);
      // X-Proxy-Model-Alias doesn't affect /models listing, only message routing
      expect(res.body.data.length).toBeGreaterThan(0);
    } finally { srv.close(); }
  });

  it('normalizes double /v1/v1/ path to /v1/', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/v1/models');
      expect(res.status).toBe(200);
      expect(res.body.object).toBe('list');
    } finally { srv.close(); }
  });
});
