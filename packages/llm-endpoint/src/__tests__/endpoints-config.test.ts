import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEndpointsConfig, readEndpointsFromDisk, resolveEndpointsFilePath } from '../endpoints.js';

// Pure-function config parsing/validation — no server, no env toggling
// concerns (unlike forge.test.ts/nebius.test.ts, which must isolate env
// across tests because they exercise the shared server module).

describe('parseEndpointsConfig', () => {
  it('accepts a minimal valid endpoint (keyless, no defaultRequestFields)', () => {
    const result = parseEndpointsConfig({
      endpoints: [{ id: 'ollama', kind: 'openai', baseUrl: 'http://192.168.1.20:11434/v1' }],
    });
    expect(result.errors).toEqual([]);
    expect(result.endpoints).toEqual([{ id: 'ollama', kind: 'openai', baseUrl: 'http://192.168.1.20:11434/v1' }]);
  });

  it('accepts apiKeyEnv, defaultRequestFields.chat_template_kwargs, and timeoutMs.firstTokenMs', () => {
    const result = parseEndpointsConfig({
      endpoints: [
        {
          id: 'bonsai',
          kind: 'openai',
          baseUrl: 'http://192.168.1.20:8081/v1',
          apiKeyEnv: 'BONSAI_API_KEY',
          defaultRequestFields: { chat_template_kwargs: { enable_thinking: false } },
          timeoutMs: { firstTokenMs: 180000 },
        },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.endpoints).toEqual([
      {
        id: 'bonsai',
        kind: 'openai',
        baseUrl: 'http://192.168.1.20:8081/v1',
        apiKeyEnv: 'BONSAI_API_KEY',
        defaultRequestFields: { chat_template_kwargs: { enable_thinking: false } },
        timeoutMs: { firstTokenMs: 180000 },
      },
    ]);
  });

  it('accepts multiple distinct endpoints', () => {
    const result = parseEndpointsConfig({
      endpoints: [
        { id: 'bonsai', kind: 'openai', baseUrl: 'http://192.168.1.20:8081/v1' },
        { id: 'ollama', kind: 'openai', baseUrl: 'http://192.168.1.20:11434/v1' },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.endpoints.map((e) => e.id)).toEqual(['bonsai', 'ollama']);
  });

  it('rejects a root without an "endpoints" array', () => {
    expect(parseEndpointsConfig({}).errors.length).toBeGreaterThan(0);
    expect(parseEndpointsConfig(null).errors.length).toBeGreaterThan(0);
    expect(parseEndpointsConfig({ endpoints: 'nope' }).errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing id', () => {
    const result = parseEndpointsConfig({ endpoints: [{ kind: 'openai', baseUrl: 'http://x:1/v1' }] });
    expect(result.endpoints).toEqual([]);
    expect(result.errors.some((e) => e.includes('endpoints[0].id'))).toBe(true);
  });

  it('rejects a bad URL', () => {
    const result = parseEndpointsConfig({ endpoints: [{ id: 'bad', kind: 'openai', baseUrl: 'not-a-url' }] });
    expect(result.endpoints).toEqual([]);
    expect(result.errors.some((e) => e.includes('endpoints[0].baseUrl'))).toBe(true);
  });

  it('rejects a non-http(s) scheme', () => {
    const result = parseEndpointsConfig({ endpoints: [{ id: 'bad', kind: 'openai', baseUrl: 'ftp://host/v1' }] });
    expect(result.endpoints).toEqual([]);
    expect(result.errors.some((e) => e.includes('endpoints[0].baseUrl'))).toBe(true);
  });

  it('rejects a kind other than "openai"', () => {
    const result = parseEndpointsConfig({ endpoints: [{ id: 'bad', kind: 'anthropic', baseUrl: 'http://host/v1' }] });
    expect(result.endpoints).toEqual([]);
    expect(result.errors.some((e) => e.includes('endpoints[0].kind'))).toBe(true);
  });

  it('rejects duplicate ids among file entries', () => {
    const result = parseEndpointsConfig({
      endpoints: [
        { id: 'bonsai', kind: 'openai', baseUrl: 'http://host-a:1/v1' },
        { id: 'bonsai', kind: 'openai', baseUrl: 'http://host-b:1/v1' },
      ],
    });
    expect(result.endpoints).toEqual([]);
    expect(result.errors.some((e) => e.includes('duplicate endpoint id "bonsai"'))).toBe(true);
  });

  it('rejects "forge" as a file entry id — it is always the implicit FORGE_BASE_URL endpoint', () => {
    const result = parseEndpointsConfig({ endpoints: [{ id: 'forge', kind: 'openai', baseUrl: 'http://host:1/v1' }] });
    expect(result.endpoints).toEqual([]);
    expect(result.errors.some((e) => e.includes('duplicate endpoint id "forge"') && e.includes('reserved'))).toBe(true);
  });

  it('rejects a non-object defaultRequestFields.chat_template_kwargs', () => {
    const result = parseEndpointsConfig({
      endpoints: [{ id: 'x', kind: 'openai', baseUrl: 'http://host:1/v1', defaultRequestFields: { chat_template_kwargs: 'nope' } }],
    });
    expect(result.endpoints).toEqual([]);
    expect(result.errors.some((e) => e.includes('defaultRequestFields.chat_template_kwargs'))).toBe(true);
  });

  it('rejects a non-positive timeoutMs.firstTokenMs', () => {
    const result = parseEndpointsConfig({
      endpoints: [{ id: 'x', kind: 'openai', baseUrl: 'http://host:1/v1', timeoutMs: { firstTokenMs: -1 } }],
    });
    expect(result.endpoints).toEqual([]);
    expect(result.errors.some((e) => e.includes('timeoutMs.firstTokenMs'))).toBe(true);
  });
});

describe('resolveEndpointsFilePath', () => {
  const SAVED = process.env.LLM_ENDPOINT_ENDPOINTS_FILE;
  it('honors LLM_ENDPOINT_ENDPOINTS_FILE when set', () => {
    process.env.LLM_ENDPOINT_ENDPOINTS_FILE = '/tmp/custom-endpoints.json';
    try {
      expect(resolveEndpointsFilePath()).toBe('/tmp/custom-endpoints.json');
    } finally {
      if (SAVED === undefined) delete process.env.LLM_ENDPOINT_ENDPOINTS_FILE;
      else process.env.LLM_ENDPOINT_ENDPOINTS_FILE = SAVED;
    }
  });

  it('defaults to ~/.agentproto/llm-endpoints.json when unset', () => {
    delete process.env.LLM_ENDPOINT_ENDPOINTS_FILE;
    try {
      expect(resolveEndpointsFilePath()).toMatch(/\.agentproto[\\/]llm-endpoints\.json$/);
    } finally {
      if (SAVED !== undefined) process.env.LLM_ENDPOINT_ENDPOINTS_FILE = SAVED;
    }
  });
});

describe('readEndpointsFromDisk', () => {
  let dir: string;

  it('a missing file is NOT an error — no endpoints configured is the normal case', async () => {
    dir = await mkdtemp(join(tmpdir(), 'llm-endpoints-cfg-'));
    try {
      const result = readEndpointsFromDisk(join(dir, 'nope.json'));
      expect(result.errors).toEqual([]);
      expect(result.endpoints).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('invalid JSON is an error, not a silent empty list', async () => {
    dir = await mkdtemp(join(tmpdir(), 'llm-endpoints-cfg-'));
    try {
      const path = join(dir, 'llm-endpoints.json');
      await writeFile(path, '{ not json');
      const result = readEndpointsFromDisk(path);
      expect(result.endpoints).toEqual([]);
      expect(result.errors.some((e) => e.includes('invalid JSON'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads and validates a real file end to end', async () => {
    dir = await mkdtemp(join(tmpdir(), 'llm-endpoints-cfg-'));
    try {
      const path = join(dir, 'llm-endpoints.json');
      await writeFile(
        path,
        JSON.stringify({
          endpoints: [
            { id: 'bonsai', kind: 'openai', baseUrl: 'http://192.168.1.20:8081/v1', apiKeyEnv: 'BONSAI_API_KEY' },
            { id: 'ollama', kind: 'openai', baseUrl: 'http://192.168.1.20:11434/v1' },
          ],
        }),
      );
      const result = readEndpointsFromDisk(path);
      expect(result.errors).toEqual([]);
      expect(result.endpoints.map((e) => e.id)).toEqual(['bonsai', 'ollama']);
      expect(result.path).toBe(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
