import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end coverage for verified per-route limit metadata on /v1/models:
// a local pack carrying contextWindow / maxOutputTokens must surface them in
// BOTH list styles — Anthropic (context_window / max_output_tokens) and OpenAI
// (context_length / max_completion_tokens) — while routes WITHOUT the fields
// must omit them entirely (no guessed constants, backward-compatible shape).
//
// Same harness pattern as packs-reload.test.ts: the access token is set BEFORE
// the server module import (vitest isolates module caches per test file), and
// packs.local.json is controlled by chdir-ing into a temp dir per test
// (readLocalPacksFromDisk resolves it from process.cwd()).

const ACCESS_TOKEN = 'model-metadata-test-token';
process.env.LLM_ENDPOINT_ACCESS_TOKENS = ACCESS_TOKEN;

const { server } = await import('../index.js');

function httpRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
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
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

const AUTH = { Authorization: `Bearer ${ACCESS_TOKEN}` };

let prevCwd: string;
let dir: string;

beforeEach(async () => {
  prevCwd = process.cwd();
  dir = await mkdtemp(join(tmpdir(), 'llm-endpoint-model-metadata-'));
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(prevCwd);
  await rm(dir, { recursive: true, force: true });
});

/** Write a local pack with one annotated route and one bare route, then reload. */
async function loadPackWithMixedRoutes(port: number) {
  const localPack = {
    packs: {
      'metadata-test': {
        id: 'metadata-test',
        label: 'Metadata test',
        description: 'One annotated route, one bare route',
        models: {
          'with-limits': {
            provider: 'openrouter',
            model: 'test/annotated-model',
            equivalentClaudeName: 'claude-sonnet-5-annotated',
            contextWindow: 1310720,
            maxOutputTokens: 131072,
          },
          'without-limits': {
            provider: 'openrouter',
            model: 'test/bare-model',
            equivalentClaudeName: 'claude-sonnet-5-bare',
          },
        },
      },
    },
  };
  await writeFile('packs.local.json', JSON.stringify(localPack));
  return httpRequest(port, '/v1/packs/reload', { method: 'POST', headers: AUTH });
}

describe('GET /v1/models with verified route limits', () => {
  it('surfaces max_input_tokens/max_tokens in Anthropic-style lists only for annotated routes', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const reloadRes = await loadPackWithMixedRoutes(port);
      expect(reloadRes.status).toBe(200);

      const res = await httpRequest(port, '/v1/models?pack=metadata-test', {
        headers: { ...AUTH, 'anthropic-version': '2023-06-01' },
      });
      expect(res.status).toBe(200);
      const models = res.body.data as Array<Record<string, unknown>>;
      const annotated = models.find((m) => m.id === 'claude-sonnet-5-annotated');
      const bare = models.find((m) => m.id === 'claude-sonnet-5-bare');
      expect(annotated).toBeDefined();
      expect(bare).toBeDefined();
      // Official Anthropic ModelInfo field names (docs /en/api/models-list).
      expect(annotated!.max_input_tokens).toBe(1310720);
      expect(annotated!.max_tokens).toBe(131072);
      expect(bare!.max_input_tokens).toBeUndefined();
      expect(bare!.max_tokens).toBeUndefined();
    } finally {
      srv.close();
    }
  });

  it('surfaces context_length/max_completion_tokens in OpenAI-style lists only for annotated routes', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const reloadRes = await loadPackWithMixedRoutes(port);
      expect(reloadRes.status).toBe(200);

      const res = await httpRequest(port, '/v1/models?pack=metadata-test', { headers: AUTH });
      expect(res.status).toBe(200);
      expect(res.body.object).toBe('list');
      const models = res.body.data as Array<Record<string, unknown>>;
      const annotated = models.find((m) => m.id === 'with-limits');
      const bare = models.find((m) => m.id === 'without-limits');
      expect(annotated).toBeDefined();
      expect(bare).toBeDefined();
      expect(annotated!.context_length).toBe(1310720);
      expect(annotated!.max_completion_tokens).toBe(131072);
      expect(bare!.context_length).toBeUndefined();
      expect(bare!.max_completion_tokens).toBeUndefined();
    } finally {
      srv.close();
    }
  });

  it('rejects an invalid contextWindow/maxOutputTokens at reload (consistent field validation)', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      await writeFile(
        'packs.local.json',
        JSON.stringify({
          packs: {
            'metadata-bad': {
              id: 'metadata-bad',
              label: 'Metadata bad',
              description: 'Negative limits must fail validation like any other bad field',
              models: {
                'bad-limits': {
                  provider: 'openrouter',
                  model: 'test/bad-model',
                  contextWindow: -1,
                  maxOutputTokens: 0,
                },
              },
            },
          },
        }),
      );
      const reloadRes = await httpRequest(port, '/v1/packs/reload', { method: 'POST', headers: AUTH });
      expect(reloadRes.status).toBe(400);
      const msg = JSON.stringify(reloadRes.body);
      expect(msg).toContain('contextWindow');
      expect(msg).toContain('maxOutputTokens');
    } finally {
      srv.close();
    }
  });
});
