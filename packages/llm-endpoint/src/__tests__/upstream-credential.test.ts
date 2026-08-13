import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @agentproto/auth so the resolver's profile-store + keychain reads are
// deterministic and NEVER touch the real ~/.agentproto/auth-profiles.json or
// the platform Keychain.
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

const { resolveUpstreamCredential, buildUpstreamAuthHeaders, isCredentialAllowedOnOpenAiSurface } =
  await import('../index.js');

// Env keys we mutate per-test. Snapshot + restore so nothing leaks between
// tests (or into other test files sharing this process).
const TOUCHED_ENV = [
  'LLM_ENDPOINT_PROFILE_ANTHROPIC',
  'LLM_ENDPOINT_PROFILE_OPENROUTER',
  'LLM_ENDPOINT_PROFILE_MOONSHOT',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'MOONSHOT_API_KEY',
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

// ── resolveUpstreamCredential ───────────────────────────────────────────────

describe('resolveUpstreamCredential', () => {
  it('resolves an env-mapped api-key profile to {value, method:"api-key"}', async () => {
    process.env.LLM_ENDPOINT_PROFILE_ANTHROPIC = 'work-anthropic';
    authMock.getAuthProfile.mockResolvedValue({
      id: 'work-anthropic',
      endpoint: 'anthropic',
      method: 'api-key',
      credentialRef: 'agentproto:cred:work-anthropic',
    });
    authMock.read.mockResolvedValue({ value: 'sk-ant-stored', kind: 'pat' });

    const cred = await resolveUpstreamCredential('anthropic');

    expect(cred).toEqual({ value: 'sk-ant-stored', method: 'api-key' });
    expect(authMock.getAuthProfile).toHaveBeenCalledWith('work-anthropic');
    expect(authMock.read).toHaveBeenCalledWith({ path: 'agentproto:cred:work-anthropic' });
  });

  it('resolves an env-mapped oauth-bearer profile to {value, method:"oauth-bearer"}', async () => {
    process.env.LLM_ENDPOINT_PROFILE_ANTHROPIC = 'claude-subs';
    authMock.getAuthProfile.mockResolvedValue({
      id: 'claude-subs',
      endpoint: 'anthropic',
      method: 'oauth-bearer',
      credentialRef: 'agentproto:cred:claude-subs',
    });
    authMock.read.mockResolvedValue({ value: 'oat-token', kind: 'oat' });

    const cred = await resolveUpstreamCredential('anthropic');

    expect(cred).toEqual({ value: 'oat-token', method: 'oauth-bearer' });
  });

  it('falls back to the env key (method:"api-key") when no profile is mapped', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';

    const cred = await resolveUpstreamCredential('anthropic');

    expect(cred).toEqual({ value: 'sk-ant-env', method: 'api-key' });
    expect(authMock.getAuthProfile).not.toHaveBeenCalled();
    expect(authMock.read).not.toHaveBeenCalled();
  });

  it('derives method:"oauth-bearer" from an env-key OAT (sk-ant-oat…) when no profile is mapped', async () => {
    // Regression: the runtime's billing-auth resolver injects a subscription
    // OAT straight into ANTHROPIC_API_KEY for a modelDerivedApiKey adapter
    // with no authSubscription (e.g. pi) — the env-key fallback must classify
    // it by its own shape, not hardcode "api-key" (which sends it as
    // x-api-key and Anthropic hard-401s: "invalid x-api-key").
    process.env.ANTHROPIC_API_KEY = 'sk-ant-oat01-abc123';

    const cred = await resolveUpstreamCredential('anthropic');

    expect(cred).toEqual({ value: 'sk-ant-oat01-abc123', method: 'oauth-bearer' });
    expect(authMock.getAuthProfile).not.toHaveBeenCalled();
  });

  it('does not misclassify an OAT-shaped value on a non-anthropic provider', async () => {
    process.env.MOONSHOT_API_KEY = 'sk-ant-oat01-abc123';

    const cred = await resolveUpstreamCredential('moonshot');

    expect(cred).toEqual({ value: 'sk-ant-oat01-abc123', method: 'api-key' });
  });

  it('returns undefined for a missing mapped profile (caller 401s)', async () => {
    process.env.LLM_ENDPOINT_PROFILE_ANTHROPIC = 'ghost';
    authMock.getAuthProfile.mockResolvedValue(undefined);

    expect(await resolveUpstreamCredential('anthropic')).toBeUndefined();
    expect(authMock.read).not.toHaveBeenCalled();
  });

  it('returns undefined for a disabled mapped profile', async () => {
    process.env.LLM_ENDPOINT_PROFILE_ANTHROPIC = 'off';
    authMock.getAuthProfile.mockResolvedValue({
      id: 'off',
      endpoint: 'anthropic',
      method: 'api-key',
      credentialRef: 'agentproto:cred:off',
      disabled: true,
    });

    expect(await resolveUpstreamCredential('anthropic')).toBeUndefined();
    expect(authMock.read).not.toHaveBeenCalled();
  });

  it('returns undefined for a source-backed profile (self-refresh not supported here)', async () => {
    process.env.LLM_ENDPOINT_PROFILE_ANTHROPIC = 'src-backed';
    authMock.getAuthProfile.mockResolvedValue({
      id: 'src-backed',
      endpoint: 'anthropic',
      method: 'oauth-bearer',
      source: 'claude-code-oauth',
      // no credentialRef
    });

    expect(await resolveUpstreamCredential('anthropic')).toBeUndefined();
    expect(authMock.read).not.toHaveBeenCalled();
  });

  it('falls back to the env key when the keychain read throws (e.g. non-darwin host)', async () => {
    process.env.LLM_ENDPOINT_PROFILE_ANTHROPIC = 'work-anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-fallback';
    authMock.getAuthProfile.mockResolvedValue({
      id: 'work-anthropic',
      endpoint: 'anthropic',
      method: 'api-key',
      credentialRef: 'agentproto:cred:work-anthropic',
    });
    authMock.read.mockRejectedValue(new Error('Keychain backend only supports macOS'));

    const cred = await resolveUpstreamCredential('anthropic');

    expect(cred).toEqual({ value: 'sk-ant-env-fallback', method: 'api-key' });
  });
});

// ── buildUpstreamAuthHeaders ────────────────────────────────────────────────

describe('buildUpstreamAuthHeaders', () => {
  it('anthropic + oauth-bearer → Bearer + anthropic-version + anthropic-beta (exactly)', () => {
    const headers = buildUpstreamAuthHeaders('anthropic', {
      value: 'oat-token',
      method: 'oauth-bearer',
    });
    expect(headers).toEqual({
      'Authorization': 'Bearer oat-token',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    });
  });

  it('anthropic + api-key → x-api-key + anthropic-version (unchanged shape)', () => {
    const headers = buildUpstreamAuthHeaders('anthropic', {
      value: 'sk-ant',
      method: 'api-key',
    });
    expect(headers).toEqual({
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
    });
  });

  it('non-anthropic api-key provider keeps its existing header shape', () => {
    expect(buildUpstreamAuthHeaders('openrouter', { value: 'sk-or', method: 'api-key' })).toEqual({
      'Authorization': 'Bearer sk-or',
    });
    expect(buildUpstreamAuthHeaders('moonshot', { value: 'sk-moon', method: 'api-key' })).toEqual({
      'X-API-Key': 'sk-moon',
    });
    expect(buildUpstreamAuthHeaders('groq', { value: 'sk-groq', method: 'api-key' })).toEqual({
      'Authorization': 'Bearer sk-groq',
    });
  });

  it('oauth-bearer on a non-anthropic provider fails closed → null (token NEVER emitted)', () => {
    // Fail-closed invariant: a Claude subscription OAT resolved for a
    // third-party host must NOT be forwarded. buildUpstreamAuthHeaders returns
    // null and the caller 401s; no Authorization header with the OAT is ever
    // produced for a non-anthropic upstream.
    for (const provider of ['openrouter', 'groq', 'xai', 'requesty', 'zai', 'openai', 'moonshot']) {
      const headers = buildUpstreamAuthHeaders(provider, {
        value: 'oat-token',
        method: 'oauth-bearer',
      });
      expect(headers).toBeNull();
      // Belt-and-suspenders: whatever it returned, it must not carry the OAT.
      expect(JSON.stringify(headers ?? {})).not.toContain('oat-token');
    }
  });
});

// ── isCredentialAllowedOnOpenAiSurface (OpenAI-compat surface guard) ─────────

describe('isCredentialAllowedOnOpenAiSurface', () => {
  it('rejects a non-api-key (oauth-bearer) credential — the OAT never rides a Bearer header there', () => {
    // The /v1/responses and /v1/chat/completions surfaces are always
    // non-anthropic and forward the credential as `Authorization: Bearer`.
    // A subscription/oauth credential must be refused (401) before any request.
    expect(isCredentialAllowedOnOpenAiSurface({ value: 'oat-token', method: 'oauth-bearer' })).toBe(false);
  });

  it('allows an api-key credential (the only shape valid on this surface)', () => {
    expect(isCredentialAllowedOnOpenAiSurface({ value: 'sk-groq', method: 'api-key' })).toBe(true);
  });

  it('allows an absent credential (the caller\'s missing-key check 401s it)', () => {
    expect(isCredentialAllowedOnOpenAiSurface(undefined)).toBe(true);
  });
});
