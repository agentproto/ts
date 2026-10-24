import { describe, expect, it } from 'vitest';
import {
  CONNECTORS,
  DEFAULT_LOCAL_PORTS,
  connectorById,
  detectConnector,
  isConnectorId,
} from '../connectors.js';

/** A fake `fetch` keyed by exact URL — anything not listed rejects like a
 *  closed port would (ECONNREFUSED), which every connector's probe/listModels
 *  must tolerate without throwing. */
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (!(url in routes)) throw new Error(`connect ECONNREFUSED ${url}`);
    return { ok: true, json: async () => routes[url] } as Response;
  }) as typeof fetch;
}

describe('isConnectorId / connectorById', () => {
  it('recognizes every registered connector id and rejects everything else', () => {
    for (const id of Object.keys(CONNECTORS)) {
      expect(isConnectorId(id)).toBe(true);
      expect(connectorById(id)?.id).toBe(id);
    }
    expect(isConnectorId('bogus')).toBe(false);
    expect(connectorById('bogus')).toBeUndefined();
  });
});

describe('lmstudio connector', () => {
  const baseUrl = 'http://127.0.0.1:1234/v1';
  const models = {
    data: [
      { id: 'bonsai-27b-win', state: 'loaded', loaded_context_length: 62976, max_context_length: 262144 },
      { id: 'other-model', state: 'not-loaded', max_context_length: 8192 },
    ],
  };

  it('probes true when /api/v0/models answers with a data array', async () => {
    const fetchImpl = fakeFetch({ 'http://127.0.0.1:1234/api/v0/models': models });
    expect(await CONNECTORS.lmstudio.probe(baseUrl, fetchImpl)).toBe(true);
  });

  it('probes false when unreachable', async () => {
    const fetchImpl = fakeFetch({});
    expect(await CONNECTORS.lmstudio.probe(baseUrl, fetchImpl)).toBe(false);
  });

  it('lists loaded/not-loaded models with ctx sizes', async () => {
    const fetchImpl = fakeFetch({ 'http://127.0.0.1:1234/api/v0/models': models });
    expect(await CONNECTORS.lmstudio.listModels(baseUrl, fetchImpl)).toEqual([
      { id: 'bonsai-27b-win', loadedCtx: 62976, maxCtx: 262144, state: 'loaded' },
      { id: 'other-model', maxCtx: 8192, state: 'not-loaded' },
    ]);
  });

  it('declares the leading-system-message quirk', () => {
    expect(CONNECTORS.lmstudio.quirks.requiresLeadingSystemMessage).toBe(true);
  });
});

describe('ollama connector', () => {
  const baseUrl = 'http://127.0.0.1:11434/v1';
  const tags = { models: [{ name: 'qwen2.5-coder' }, { name: 'llama3' }] };
  const ps = { models: [{ name: 'qwen2.5-coder' }] };

  it('probes true when /api/tags answers with a models array', async () => {
    const fetchImpl = fakeFetch({ 'http://127.0.0.1:11434/api/tags': tags });
    expect(await CONNECTORS.ollama.probe(baseUrl, fetchImpl)).toBe(true);
  });

  it('marks models present in /api/ps as loaded, others not-loaded', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.1:11434/api/tags': tags,
      'http://127.0.0.1:11434/api/ps': ps,
    });
    expect(await CONNECTORS.ollama.listModels(baseUrl, fetchImpl)).toEqual([
      { id: 'qwen2.5-coder', state: 'loaded' },
      { id: 'llama3', state: 'not-loaded' },
    ]);
  });
});

describe('llama-server connector', () => {
  const baseUrl = 'http://127.0.0.1:8080/v1';
  const props = { default_generation_settings: { n_ctx: 32768 } };
  const models = { data: [{ id: 'local-model' }] };

  it('probes true when /props answers with generation settings', async () => {
    const fetchImpl = fakeFetch({ 'http://127.0.0.1:8080/props': props });
    expect(await CONNECTORS['llama-server'].probe(baseUrl, fetchImpl)).toBe(true);
  });

  it('lists models with ctx from /props', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.1:8080/props': props,
      'http://127.0.0.1:8080/v1/models': models,
    });
    expect(await CONNECTORS['llama-server'].listModels(baseUrl, fetchImpl)).toEqual([
      { id: 'local-model', loadedCtx: 32768, maxCtx: 32768, state: 'loaded' },
    ]);
  });
});

describe('vllm connector', () => {
  const baseUrl = 'http://127.0.0.1:8000/v1';
  const models = { data: [{ id: 'mid-model', max_model_len: 16384 }] };

  it('probes true only when a model entry carries max_model_len', async () => {
    const fetchImpl = fakeFetch({ 'http://127.0.0.1:8000/v1/models': models });
    expect(await CONNECTORS.vllm.probe(baseUrl, fetchImpl)).toBe(true);

    const noLen = fakeFetch({ 'http://127.0.0.1:8000/v1/models': { data: [{ id: 'x' }] } });
    expect(await CONNECTORS.vllm.probe(baseUrl, noLen)).toBe(false);
  });

  it('lists models with maxCtx/loadedCtx from max_model_len', async () => {
    const fetchImpl = fakeFetch({ 'http://127.0.0.1:8000/v1/models': models });
    expect(await CONNECTORS.vllm.listModels(baseUrl, fetchImpl)).toEqual([
      { id: 'mid-model', loadedCtx: 16384, maxCtx: 16384, state: 'loaded' },
    ]);
  });
});

describe('openai-compatible fallback connector', () => {
  const baseUrl = 'http://192.168.1.20:8081/v1';
  const models = { data: [{ id: 'whatever' }] };

  it('probes true on any reachable OpenAI-compatible /models', async () => {
    const fetchImpl = fakeFetch({ 'http://192.168.1.20:8081/v1/models': models });
    expect(await CONNECTORS['openai-compatible'].probe(baseUrl, fetchImpl)).toBe(true);
  });

  it('lists models with unknown state (no runtime-specific signal available)', async () => {
    const fetchImpl = fakeFetch({ 'http://192.168.1.20:8081/v1/models': models });
    expect(await CONNECTORS['openai-compatible'].listModels(baseUrl, fetchImpl)).toEqual([
      { id: 'whatever', state: 'unknown' },
    ]);
  });

  it('has no default port — never targeted by default-port detection', () => {
    expect(CONNECTORS['openai-compatible'].defaultPort).toBeNull();
    expect(DEFAULT_LOCAL_PORTS['openai-compatible']).toBeUndefined();
  });
});

describe('detectConnector', () => {
  it('prefers a more specific connector over the generic fallback', async () => {
    // LM Studio's own endpoint plus a same-server OpenAI-compatible /models —
    // detection must land on lmstudio, not openai-compatible.
    const fetchImpl = fakeFetch({
      'http://127.0.0.1:1234/api/v0/models': { data: [{ id: 'm', state: 'loaded' }] },
      'http://127.0.0.1:1234/v1/models': { data: [{ id: 'm' }] },
    });
    expect(await detectConnector('http://127.0.0.1:1234/v1', fetchImpl)).toBe('lmstudio');
  });

  it('falls back to openai-compatible when nothing more specific answers', async () => {
    const fetchImpl = fakeFetch({ 'http://192.168.1.20:8081/v1/models': { data: [{ id: 'm' }] } });
    expect(await detectConnector('http://192.168.1.20:8081/v1', fetchImpl)).toBe('openai-compatible');
  });

  it('returns null when nothing is reachable at all', async () => {
    const fetchImpl = fakeFetch({});
    expect(await detectConnector('http://127.0.0.1:9999/v1', fetchImpl)).toBeNull();
  });
});
