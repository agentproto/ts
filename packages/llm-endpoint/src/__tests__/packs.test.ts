import { describe, it, expect } from 'vitest';
import {
  matchesPattern,
  resolvePack,
  buildMappingFromPack,
  listPackIds,
  DEFAULT_PACK_ID,
  PACK_REGISTRY,
  anthropicPack,
  xaiPack,
  openrouterPack,
  type ModelPack,
} from '../packs.js';

// ── matchesPattern ────────────────────────────────────────────────────────

describe('matchesPattern', () => {
  it('exact match returns true', () => {
    expect(matchesPattern('Bash', 'Bash')).toBe(true);
  });

  it('exact match is case-sensitive', () => {
    expect(matchesPattern('bash', 'Bash')).toBe(false);
  });

  it('exact match returns false for different names', () => {
    expect(matchesPattern('Read', 'Write')).toBe(false);
  });

  it('underscore-suffix wildcard: "agentproto_*" matches "agentproto_start"', () => {
    expect(matchesPattern('agentproto_start', 'agentproto_*')).toBe(true);
  });

  it('underscore-suffix wildcard: "agentproto_*" matches "agentproto_stop"', () => {
    expect(matchesPattern('agentproto_stop', 'agentproto_*')).toBe(true);
  });

  it('underscore-suffix wildcard does not match partial prefix', () => {
    expect(matchesPattern('agentproto', 'agentproto_*')).toBe(false);
  });

  it('non-underscore wildcard: "prefix*" matches "prefixFoo"', () => {
    expect(matchesPattern('prefixFoo', 'prefix*')).toBe(true);
  });

  it('non-underscore wildcard: "prefix*" does not match "otherFoo"', () => {
    expect(matchesPattern('otherFoo', 'prefix*')).toBe(false);
  });

  it('bare "*" wildcard matches everything', () => {
    expect(matchesPattern('anything', '*')).toBe(true);
    expect(matchesPattern('', '*')).toBe(true);
  });

  it('wildcard with empty prefix ("*") does not require underscore separator', () => {
    // Regression: the old "_*" suffix check would fail for "prefix*" without underscore
    expect(matchesPattern('getWeather', 'get*')).toBe(true);
    expect(matchesPattern('setWeather', 'get*')).toBe(false);
  });
});

// ── resolvePack ───────────────────────────────────────────────────────────

describe('resolvePack', () => {
  it('returns the default pack when called with null', () => {
    const pack = resolvePack(null);
    expect(pack.id).toBe(DEFAULT_PACK_ID);
  });

  it('returns the default pack when called with undefined', () => {
    const pack = resolvePack(undefined);
    expect(pack.id).toBe(DEFAULT_PACK_ID);
  });

  it('returns the default pack when called with empty string', () => {
    const pack = resolvePack('');
    expect(pack.id).toBe(DEFAULT_PACK_ID);
  });

  it('returns the correct pack for a known ID', () => {
    const pack = resolvePack('xai');
    expect(pack.id).toBe('xai');
    expect(pack).toBe(xaiPack);
  });

  it('returns the anthropic pack by ID', () => {
    expect(resolvePack('anthropic')).toBe(anthropicPack);
  });

  it('returns the openrouter pack by ID', () => {
    expect(resolvePack('openrouter')).toBe(openrouterPack);
  });

  it('throws RangeError for an unknown pack ID (no silent fallback)', () => {
    expect(() => resolvePack('nonexistent-pack')).toThrow(RangeError);
    expect(() => resolvePack('nonexistent-pack')).toThrow(/Unknown pack id/);
  });

  it('error message includes the unknown ID', () => {
    expect(() => resolvePack('my-pack')).toThrow(/my-pack/);
  });

  it('error message lists available pack IDs', () => {
    try {
      resolvePack('bad-id');
    } catch (err) {
      expect(err).toBeInstanceOf(RangeError);
      const msg = (err as RangeError).message;
      expect(msg).toContain('openrouter');
      expect(msg).toContain('xai');
      expect(msg).toContain('anthropic');
    }
  });
});

// ── buildMappingFromPack ──────────────────────────────────────────────────

describe('buildMappingFromPack', () => {
  it('returns all models from the pack', () => {
    const mapping = buildMappingFromPack(xaiPack);
    expect(Object.keys(mapping)).toEqual(Object.keys(xaiPack.models));
  });

  it('returns a shallow copy (not the same reference)', () => {
    const mapping = buildMappingFromPack(openrouterPack);
    expect(mapping).not.toBe(openrouterPack.models);
  });

  it('each entry contains provider, model, and equivalentClaudeName', () => {
    const mapping = buildMappingFromPack(anthropicPack);
    for (const [_code, target] of Object.entries(mapping)) {
      expect(target).toHaveProperty('provider');
      expect(target).toHaveProperty('model');
      expect(target).toHaveProperty('equivalentClaudeName');
    }
  });

  it('returns an empty mapping for a pack with no models', () => {
    const emptyPack: ModelPack = { id: 'empty', label: 'Empty', description: '', models: {} };
    expect(buildMappingFromPack(emptyPack)).toEqual({});
  });

  it('mapping values match the pack model entries exactly', () => {
    const mapping = buildMappingFromPack(xaiPack);
    expect(mapping['nova-1']).toEqual(xaiPack.models['nova-1']);
  });
});

// ── listPackIds ───────────────────────────────────────────────────────────

describe('listPackIds', () => {
  it('includes all official pack IDs', () => {
    const ids = listPackIds();
    expect(ids).toContain('anthropic');
    expect(ids).toContain('xai');
    expect(ids).toContain('openrouter');
  });

  it('matches the keys of PACK_REGISTRY', () => {
    expect(listPackIds()).toEqual(Object.keys(PACK_REGISTRY));
  });
});

// ── PACK_REGISTRY integrity ───────────────────────────────────────────────

describe('PACK_REGISTRY', () => {
  it('DEFAULT_PACK_ID is present in the registry', () => {
    expect(PACK_REGISTRY[DEFAULT_PACK_ID]).toBeDefined();
  });

  it('all packs have unique equivalentClaudeNames within each pack', () => {
    for (const pack of Object.values(PACK_REGISTRY)) {
      const names = Object.values(pack.models).map(m => m.equivalentClaudeName);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    }
  });

  it('all pack model entries have non-empty provider and model fields', () => {
    for (const pack of Object.values(PACK_REGISTRY)) {
      for (const [code, target] of Object.entries(pack.models)) {
        expect(target.provider, `${pack.id}/${code}.provider`).toBeTruthy();
        expect(target.model, `${pack.id}/${code}.model`).toBeTruthy();
        expect(target.equivalentClaudeName, `${pack.id}/${code}.equivalentClaudeName`).toBeTruthy();
      }
    }
  });
});
