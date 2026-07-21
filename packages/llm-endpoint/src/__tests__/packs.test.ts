import { describe, it, expect } from 'vitest';
import {
  matchesPattern,
  resolvePack,
  buildMappingFromPack,
  listPackIds,
  DEFAULT_PACK_ID,
  PACK_REGISTRY,
  defaultPack,
  xaiPack,
  openrouterPack,
  anthropicPack,
  codingPack,
  parseTransparentModel,
  toAnthropicStyle,
  shaNumericId,
  TIER_TO_FAMILY,
  type ModelPack,
} from '../packs.js';

// Bare Claude ids the Anthropic-style transform must never emit — guarding
// against impersonating a real Anthropic model.
const REAL_CLAUDE_IDS = new Set([
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4.8',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
]);

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

  it('returns the default pack by ID', () => {
    expect(resolvePack('default')).toBe(defaultPack);
  });

  it('returns the openrouter pack by ID', () => {
    expect(resolvePack('openrouter')).toBe(openrouterPack);
  });

  it('resolves the anthropic pack by ID', () => {
    expect(resolvePack('anthropic')).toBe(anthropicPack);
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
      expect(msg).toContain('default');
      expect(msg).toContain('xai');
      expect(msg).toContain('openrouter');
    }
  });
});

// ── anthropicPack ─────────────────────────────────────────────────────────

describe('anthropicPack', () => {
  it('has id "anthropic"', () => {
    expect(anthropicPack.id).toBe('anthropic');
  });

  it('routes all keys to the anthropic provider', () => {
    for (const [key, route] of Object.entries(anthropicPack.models)) {
      expect(route.provider, `${key}.provider`).toBe('anthropic');
    }
  });

  it('routes haiku key to the live datestamped model id (Anthropic has no bare alias for it)', () => {
    expect(anthropicPack.models['claude-haiku-4-5']?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('key and model id match for every entry except the documented haiku exception', () => {
    const datestampExceptions = new Set(['claude-haiku-4-5']);
    for (const [key, route] of Object.entries(anthropicPack.models)) {
      if (datestampExceptions.has(key)) continue;
      expect(route.model, `key "${key}" should match its routed model id`).toBe(key);
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
    const mapping = buildMappingFromPack(defaultPack);
    expect(mapping).not.toBe(defaultPack.models);
  });

  it('each entry contains provider and model fields', () => {
    const mapping = buildMappingFromPack(openrouterPack);
    for (const [_code, target] of Object.entries(mapping)) {
      expect(target).toHaveProperty('provider');
      expect(target).toHaveProperty('model');
    }
  });

  it('returns an empty mapping for a pack with no models', () => {
    const emptyPack: ModelPack = { id: 'empty', label: 'Empty', description: '', models: {} };
    expect(buildMappingFromPack(emptyPack)).toEqual({});
  });

  it('mapping values match the pack model entries exactly', () => {
    const mapping = buildMappingFromPack(xaiPack);
    expect(mapping['grok-4.5']).toEqual(xaiPack.models['grok-4.5']);
  });
});

// ── parseTransparentModel ─────────────────────────────────────────────────

describe('parseTransparentModel', () => {
  it('parses provider/model references', () => {
    expect(parseTransparentModel('moonshot/kimi-k2.7-code')).toEqual({
      provider: 'moonshot',
      model: 'kimi-k2.7-code',
    });
  });

  it('preserves nested namespaces for openrouter', () => {
    expect(parseTransparentModel('openrouter/anthropic/claude-3-5-sonnet-20241022')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-3-5-sonnet-20241022',
    });
  });

  it('preserves nested namespaces for requesty', () => {
    expect(parseTransparentModel('requesty/sference/thinkingcap-qwen3.6-27b')).toEqual({
      provider: 'requesty',
      model: 'sference/thinkingcap-qwen3.6-27b',
    });
  });

  it('returns null for unknown provider prefixes', () => {
    expect(parseTransparentModel('unknown/gpt-4')).toBeNull();
  });

  it('returns null for bare model ids', () => {
    expect(parseTransparentModel('gpt-4')).toBeNull();
  });
});

// ── listPackIds ───────────────────────────────────────────────────────────

describe('listPackIds', () => {
  it('includes all official pack IDs', () => {
    const ids = listPackIds();
    expect(ids).toContain('default');
    expect(ids).toContain('xai');
    expect(ids).toContain('openrouter');
    expect(ids).toContain('requesty');
    expect(ids).toContain('anthropic');
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
      const names = Object.values(pack.models)
        .map(m => m.equivalentClaudeName)
        .filter((n): n is string => Boolean(n));
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    }
  });

  it('all pack model entries have non-empty provider and model fields', () => {
    for (const pack of Object.values(PACK_REGISTRY)) {
      for (const [code, target] of Object.entries(pack.models)) {
        expect(target.provider, `${pack.id}/${code}.provider`).toBeTruthy();
        expect(target.model, `${pack.id}/${code}.model`).toBeTruthy();
      }
    }
  });

  it('requesty pack stays provider-transparent (no Claude aliases)', () => {
    // The committed Requesty pack routes upstream ids as-is. Claude-name
    // compatibility for this router is a local-pack concern — the alias
    // resolution path only fires for local packs anyway (`allowAliases &&
    // isLocalPack`), so an alias here would be inert as well as dishonest.
    const pack = PACK_REGISTRY['requesty']!;
    for (const [code, target] of Object.entries(pack.models)) {
      expect(target.provider, `requesty/${code}.provider`).toBe('requesty');
      expect(target.equivalentClaudeName, `requesty/${code} alias`).toBeUndefined();
      // The pack code IS the upstream id — no rewriting.
      expect(target.model, `requesty/${code}.model`).toBe(code);
    }
  });

  it('never maps a real Claude alias to a non-Anthropic target', () => {
    // Public packs may only bind real Claude names to actual Anthropic models
    // (currently routed through OpenRouter). Local packs are exempt because they
    // are explicitly opted-in compatibility aliases.
    for (const pack of Object.values(PACK_REGISTRY)) {
      for (const [code, target] of Object.entries(pack.models)) {
        const alias = target.equivalentClaudeName;
        if (!alias) continue;
        if (alias.startsWith('claude-')) {
          expect(target.provider, `${pack.id}/${code} Claude alias target`).toBe('openrouter');
          expect(target.model, `${pack.id}/${code} Claude alias model`).toMatch(/^anthropic\//);
        }
      }
    }
  });

  it('codingPack carries no hardcoded aliases (Anthropic-style is a runtime transform)', () => {
    for (const [code, target] of Object.entries(codingPack.models)) {
      expect(target.equivalentClaudeName, `coding/${code}`).toBeUndefined();
    }
  });
});

// ── codingPack ────────────────────────────────────────────────────────────

describe('codingPack', () => {
  it('is registered under "coding"', () => {
    expect(resolvePack('coding')).toBe(codingPack);
    expect(listPackIds()).toContain('coding');
  });

  it('routes every model through OpenRouter with a tier and no alias', () => {
    for (const [code, route] of Object.entries(codingPack.models)) {
      expect(route.provider, `${code}.provider`).toBe('openrouter');
      expect(route.model, `${code}.model`).toBe(code); // transparent: code === upstream id
      expect(route.tier, `${code}.tier`).toBeTruthy();
      expect(route.equivalentClaudeName, `${code}.alias`).toBeUndefined();
    }
  });

  it('curates the expected production routes (no free/preview)', () => {
    expect(Object.keys(codingPack.models).sort()).toEqual([
      'anthropic/claude-opus-4.8',
      'anthropic/claude-sonnet-5',
      'deepseek/deepseek-v4-pro',
      'minimax/minimax-m3',
      'openai/gpt-5.5',
      'z-ai/glm-5.2',
    ]);
    for (const code of Object.keys(codingPack.models)) {
      expect(code).not.toMatch(/:free$/);
      expect(code).not.toMatch(/preview/);
    }
  });
});

// ── shaNumericId ──────────────────────────────────────────────────────────

describe('shaNumericId', () => {
  it('is deterministic for the same input', () => {
    expect(shaNumericId('anthropic/claude-sonnet-5')).toBe(shaNumericId('anthropic/claude-sonnet-5'));
  });

  it('produces a fixed-length zero-padded numeric string', () => {
    expect(shaNumericId('z-ai/glm-5.2', 7)).toMatch(/^\d{7}$/);
    expect(shaNumericId('minimax/minimax-m3', 10)).toMatch(/^\d{10}$/);
  });

  it('differs across distinct inputs', () => {
    expect(shaNumericId('a/b')).not.toBe(shaNumericId('a/c'));
  });
});

// ── toAnthropicStyle ──────────────────────────────────────────────────────

describe('toAnthropicStyle', () => {
  it('is deterministic (same input pack → identical output)', () => {
    expect(toAnthropicStyle(codingPack)).toEqual(toAnthropicStyle(codingPack));
  });

  it('preserves code (display name), provider, model, and tier', () => {
    const styled = toAnthropicStyle(codingPack);
    for (const [code, route] of Object.entries(styled.models)) {
      const orig = codingPack.models[code]!;
      expect(route.provider).toBe(orig.provider);
      expect(route.model).toBe(orig.model);
      expect(route.tier).toBe(orig.tier);
    }
  });

  it('emits claude-<family>-<digits> aliases from the route tier', () => {
    const styled = toAnthropicStyle(codingPack);
    for (const [code, route] of Object.entries(styled.models)) {
      const family = TIER_TO_FAMILY[codingPack.models[code]!.tier!];
      expect(route.equivalentClaudeName).toMatch(
        new RegExp(`^claude-(fable|opus|sonnet|haiku)-\\d+$`),
      );
      expect(route.equivalentClaudeName!.startsWith(`claude-${family}-`)).toBe(true);
    }
  });

  it('never emits a bare real Claude id, and aliases are unique within the pack', () => {
    const styled = toAnthropicStyle(codingPack);
    const aliases = Object.values(styled.models).map(m => m.equivalentClaudeName!);
    for (const a of aliases) expect(REAL_CLAUDE_IDS.has(a), a).toBe(false);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('falls back to the sonnet family when a route carries no tier', () => {
    const untiered: ModelPack = {
      id: 'x', label: 'X', description: '',
      models: { 'openrouter/foo/bar': { provider: 'openrouter', model: 'foo/bar' } },
    };
    const styled = toAnthropicStyle(untiered);
    expect(styled.models['openrouter/foo/bar']!.equivalentClaudeName).toMatch(/^claude-sonnet-\d+$/);
  });

  it('honors id/label overrides and keeps the description', () => {
    const styled = toAnthropicStyle(codingPack, { id: 'coding-anthropic', label: 'Coding (Anthropic)' });
    expect(styled.id).toBe('coding-anthropic');
    expect(styled.label).toBe('Coding (Anthropic)');
    expect(styled.description).toBe(codingPack.description);
  });
});
