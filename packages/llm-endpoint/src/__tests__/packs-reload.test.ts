import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercises the POST /v1/packs/reload hot-reload endpoint end-to-end against the
// real server: the shared inbound access gate (401 without a token, 200 with),
// the reloaded-ids response, and the hard 400 an EXPLICIT reload returns on an
// invalid packs.local.json (unlike the fail-soft load path).
//
// The access token is set BEFORE the server module is imported so its cached
// allow-list picks it up; vitest isolates modules per test file, so this token
// is scoped to this file. packs.local.json is controlled by chdir-ing into a
// temp dir per test (readLocalPacksFromDisk resolves it from process.cwd()).

const ACCESS_TOKEN = 'reload-test-token';
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
  dir = await mkdtemp(join(tmpdir(), 'llm-endpoint-reload-'));
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(prevCwd);
  await rm(dir, { recursive: true, force: true });
});

async function reload(port: number, headers: Record<string, string> = AUTH) {
  return httpRequest(port, '/v1/packs/reload', { method: 'POST', headers });
}

describe('POST /v1/packs/reload', () => {
  it('401s without a valid access token', async () => {
    const srv = server.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await reload(port, {});
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe('authentication_error');
    } finally {
      srv.close();
    }
  });

  it('200s with a valid token and returns the reloaded pack ids + count', async () => {
    await writeFile(
      join(dir, 'packs.local.json'),
      JSON.stringify({
        packs: {
          mine: {
            id: 'mine',
            label: 'Mine',
            description: 'local test pack',
            models: { a: { provider: 'openai', model: 'gpt-4o' } },
          },
        },
      }),
    );
    const srv = server.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await reload(port);
      expect(res.status).toBe(200);
      expect(res.body.reloaded).toBe(true);
      expect(res.body.local_pack_ids).toContain('mine');
      // The merged id list carries both the built-ins and the local pack.
      expect(res.body.pack_ids).toContain('mine');
      expect(res.body.pack_ids).toContain('default');
      expect(res.body.count).toBe(res.body.pack_ids.length);
    } finally {
      srv.close();
    }
  });

  it('400s with field-scoped errors on an invalid local packs envelope', async () => {
    await writeFile(
      join(dir, 'packs.local.json'),
      JSON.stringify({
        packs: {
          broken: {
            id: 'broken',
            label: 'B',
            description: 'missing a route provider',
            models: { z: { model: 'm' } },
          },
        },
      }),
    );
    const srv = server.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await reload(port);
      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(Array.isArray(res.body.error.errors)).toBe(true);
      expect(res.body.error.errors.some((e: string) => e.includes('packs.broken.models.z.provider'))).toBe(true);
    } finally {
      srv.close();
    }
  });
});
