import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'http';

// Mock @agentproto/auth so the profile-store + keychain reads are deterministic
// and NEVER touch the real ~/.agentproto/auth-profiles.json or the platform
// Keychain (mirrors upstream-credential.test.ts).
const authMock = vi.hoisted(() => ({
  getAuthProfile: vi.fn(),
  read: vi.fn(),
}));

vi.mock('@agentproto/auth', () => ({
  getAuthProfile: authMock.getAuthProfile,
  KeychainStore: class {
    read = authMock.read;
  },
}));

// The inbound access gate reads LLM_ENDPOINT_ACCESS_TOKENS ONCE at first
// request (cached), so it must be set before the module is imported for the
// server routes to be gated in this file.
process.env.LLM_ENDPOINT_ACCESS_TOKENS = 'unit-tok';

const {
  collectUpstreamStatuses,
  describeUpstreamStatus,
  testUpstream,
  isCanonicalUpstream,
  CANONICAL_UPSTREAMS,
  server,
} = await import('../index.js');

// Env we mutate per-test — snapshot + restore so nothing leaks between tests
// (or into other files sharing this process).
const TOUCHED_ENV = [
  'LLM_ENDPOINT_PROFILE_ANTHROPIC',
  'LLM_ENDPOINT_PROFILE_MOONSHOT',
  'LLM_ENDPOINT_PROFILE_GROQ',
  'ANTHROPIC_API_KEY',
  'MOONSHOT_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'REQUESTY_API_KEY',
  'ZHIPUAI_API_KEY',
  'ZAI_API_KEY',
  'XAI_API_KEY',
  'OPENAI_API_KEY',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(TOUCHED_ENV.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED_ENV) delete process.env[k];
  authMock.getAuthProfile.mockReset();
  authMock.read.mockReset();
});

afterEach(() => {
  for (const k of TOUCHED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── describeUpstreamStatus / collectUpstreamStatuses ────────────────────────

describe('describeUpstreamStatus', () => {
  it('reports source:env + present:true for a non-empty env key (no keychain)', async () => {
    process.env.GROQ_API_KEY = 'secret-groq-key';
    const status = await describeUpstreamStatus('groq', { probe: false });
    expect(status).toEqual({
      provider: 'groq',
      linkedProfile: null,
      source: 'env',
      method: 'api-key',
      present: true,
    });
    // The secret value is NEVER part of the status.
    expect(JSON.stringify(status)).not.toContain('secret-groq-key');
    expect(authMock.read).not.toHaveBeenCalled();
  });

  it('reports source:none + present:false when nothing is configured', async () => {
    const status = await describeUpstreamStatus('requesty', { probe: false });
    expect(status).toEqual({
      provider: 'requesty',
      linkedProfile: null,
      source: 'none',
      method: null,
      present: false,
    });
  });

  it('reports source:profile + linkedProfile + method, present null without probe', async () => {
    process.env.LLM_ENDPOINT_PROFILE_MOONSHOT = 'work-moonshot';
    authMock.getAuthProfile.mockResolvedValue({
      id: 'work-moonshot',
      endpoint: 'moonshot',
      method: 'api-key',
      credentialRef: 'agentproto:cred:work-moonshot',
    });
    const status = await describeUpstreamStatus('moonshot', { probe: false });
    expect(status).toEqual({
      provider: 'moonshot',
      linkedProfile: 'work-moonshot',
      source: 'profile',
      method: 'api-key',
      present: null,
    });
    // No probe ⇒ no keychain read.
    expect(authMock.read).not.toHaveBeenCalled();
  });

  it('fills present via a keychain read only when ?probe=1, never leaking the value', async () => {
    process.env.LLM_ENDPOINT_PROFILE_ANTHROPIC = 'claude-subs';
    authMock.getAuthProfile.mockResolvedValue({
      id: 'claude-subs',
      endpoint: 'anthropic',
      method: 'oauth-bearer',
      credentialRef: 'agentproto:cred:claude-subs',
    });
    authMock.read.mockResolvedValue({ value: 'sk-ant-super-secret', kind: 'oat' });
    const status = await describeUpstreamStatus('anthropic', { probe: true });
    expect(status.source).toBe('profile');
    expect(status.method).toBe('oauth-bearer');
    expect(status.present).toBe(true);
    expect(authMock.read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(status)).not.toContain('sk-ant-super-secret');
  });

  it('present:null on probe when a mapped profile is missing (fail-closed metadata)', async () => {
    process.env.LLM_ENDPOINT_PROFILE_GROQ = 'ghost';
    authMock.getAuthProfile.mockResolvedValue(undefined);
    const status = await describeUpstreamStatus('groq', { probe: true });
    expect(status.source).toBe('profile');
    expect(status.linkedProfile).toBe('ghost');
    expect(status.method).toBeNull();
    // resolveUpstreamCredential 401s a missing profile ⇒ not present.
    expect(status.present).toBe(false);
  });
});

describe('collectUpstreamStatuses', () => {
  it('returns all 8 canonical upstreams in ProviderKeys order, no secrets', async () => {
    process.env.XAI_API_KEY = 'secret-xai-key';
    const data = await collectUpstreamStatuses({ probe: false });
    expect(data.map((d) => d.provider)).toEqual([...CANONICAL_UPSTREAMS]);
    expect(CANONICAL_UPSTREAMS).toEqual([
      'anthropic',
      'moonshot',
      'openrouter',
      'requesty',
      'zai',
      'groq',
      'xai',
      'openai',
    ]);
    expect(JSON.stringify(data)).not.toContain('secret-xai-key');
    const xai = data.find((d) => d.provider === 'xai');
    expect(xai?.source).toBe('env');
  });
});

// ── testUpstream (no live network in unit scope) ────────────────────────────

describe('testUpstream', () => {
  it('returns {ok:false, status:401} with no network when no credential resolves', async () => {
    const result = await testUpstream('xai');
    expect(result).toEqual({ ok: false, status: 401, detail: 'no credential resolved for this upstream' });
  });

  it('returns {ok:null, reason:"no-probe"} for a provider with no cheap probe', async () => {
    const result = await testUpstream('bogus-provider');
    expect(result).toEqual({ ok: null, reason: 'no-probe' });
  });
});

describe('isCanonicalUpstream', () => {
  it('accepts the 8 canonical upstreams and rejects others', () => {
    for (const p of CANONICAL_UPSTREAMS) expect(isCanonicalUpstream(p)).toBe(true);
    expect(isCanonicalUpstream('bogus')).toBe(false);
    expect(isCanonicalUpstream('messages')).toBe(false);
  });
});

// ── HTTP routes (gate + shape) ──────────────────────────────────────────────

function httpRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      { hostname: 'localhost', port, path, method: options.method || 'GET', headers: options.headers },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let body: any = null;
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
          resolvePromise({ status: res.statusCode || 0, body, raw });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const AUTH = { Authorization: 'Bearer unit-tok' };

describe('GET /v1/upstreams', () => {
  it('401s an unauthenticated request (gated, no public exemption)', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/upstreams');
      expect(res.status).toBe(401);
    } finally {
      srv.close();
    }
  });

  it('200s an authenticated request with the 8-upstream list and no secret in the body', async () => {
    process.env.GROQ_API_KEY = 'secret-groq-body';
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/upstreams', { headers: AUTH });
      expect(res.status).toBe(200);
      expect(res.body.object).toBe('list');
      expect(res.body.probe).toBe(false);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(8);
      const groq = res.body.data.find((d: any) => d.provider === 'groq');
      expect(groq.source).toBe('env');
      expect(groq.present).toBe(true);
      // No secret value ever appears in the response.
      expect(res.raw).not.toContain('secret-groq-body');
      // The status objects carry no `value`/secret-bearing field.
      for (const d of res.body.data) {
        expect(d).not.toHaveProperty('value');
        expect(d).not.toHaveProperty('credential');
      }
    } finally {
      srv.close();
    }
  });
});

describe('POST /v1/upstreams/:provider/test', () => {
  it('401s an unauthenticated request', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/upstreams/anthropic/test', { method: 'POST' });
      expect(res.status).toBe(401);
    } finally {
      srv.close();
    }
  });

  it('404s an unknown upstream', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/upstreams/bogus/test', { method: 'POST', headers: AUTH });
      expect(res.status).toBe(404);
      expect(res.body.error.type).toBe('invalid_request_error');
    } finally {
      srv.close();
    }
  });

  it('returns the {provider, ok, status, detail} verdict shape (no credential ⇒ 401 verdict, no network)', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as any).port;
    try {
      const res = await httpRequest(port, '/v1/upstreams/xai/test', { method: 'POST', headers: AUTH });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        provider: 'xai',
        ok: false,
        status: 401,
        detail: 'no credential resolved for this upstream',
      });
    } finally {
      srv.close();
    }
  });
});
