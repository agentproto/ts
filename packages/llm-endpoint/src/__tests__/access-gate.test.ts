import { describe, it, expect } from 'vitest';
import {
  parseAccessTokens,
  extractInboundToken,
  isAuthorized,
  normalizeProxyPath,
  extractEdgeToken,
  isEdgeAuthorized,
  buildWafRuleExpression,
} from '../index.js';

describe('parseAccessTokens', () => {
  it('is empty (gate off) for undefined/empty', () => {
    expect(parseAccessTokens(undefined).size).toBe(0);
    expect(parseAccessTokens('').size).toBe(0);
    expect(parseAccessTokens('  , ,').size).toBe(0);
  });
  it('splits, trims, and drops blanks', () => {
    const t = parseAccessTokens(' a , b ,,c ');
    expect([...t].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('extractInboundToken', () => {
  it('reads Authorization: Bearer (case-insensitive scheme)', () => {
    expect(extractInboundToken({ authorization: 'Bearer tok_1' })).toBe('tok_1');
    expect(extractInboundToken({ authorization: 'bearer tok_2' })).toBe('tok_2');
  });
  it('reads X-Proxy-Access', () => {
    expect(extractInboundToken({ 'x-proxy-access': 'tok_3' })).toBe('tok_3');
  });
  it('handles array-valued headers', () => {
    // `authorization` is narrowed to `string` in IncomingHttpHeaders; use an
    // index-signature header (legitimately `string | string[]`) to exercise the
    // Array.isArray branch without a type error.
    expect(extractInboundToken({ 'x-proxy-access': ['tok_4'] })).toBe('tok_4');
  });
  it('returns null when absent or malformed', () => {
    expect(extractInboundToken({})).toBeNull();
    expect(extractInboundToken({ authorization: 'Bearer   ' })).toBeNull();
    expect(extractInboundToken({ authorization: 'Basic abc' })).toBeNull();
  });
});

describe('isAuthorized', () => {
  const tokens = parseAccessTokens('good_1,good_2');
  it('is OPEN when the allow-list is empty (gate disabled)', () => {
    expect(isAuthorized({}, new Set())).toBe(true);
    expect(isAuthorized({ authorization: 'Bearer anything' }, new Set())).toBe(true);
  });
  it('allows a request carrying a listed token', () => {
    expect(isAuthorized({ authorization: 'Bearer good_1' }, tokens)).toBe(true);
    expect(isAuthorized({ 'x-proxy-access': 'good_2' }, tokens)).toBe(true);
  });
  it('rejects a missing or unlisted token when the gate is on', () => {
    expect(isAuthorized({}, tokens)).toBe(false);
    expect(isAuthorized({ authorization: 'Bearer nope' }, tokens)).toBe(false);
  });
});

describe('normalizeProxyPath', () => {
  it('leaves clean paths untouched', () => {
    expect(normalizeProxyPath('/v1/messages')).toBe('/v1/messages');
    expect(normalizeProxyPath('/v1/models')).toBe('/v1/models');
    expect(normalizeProxyPath('/v1/stealth-requesty/messages')).toBe('/v1/stealth-requesty/messages');
    expect(normalizeProxyPath('/v1/stealth-requesty/models')).toBe('/v1/stealth-requesty/models');
  });
  it('collapses the leading double /v1 (base ends in /v1)', () => {
    expect(normalizeProxyPath('/v1/v1/messages')).toBe('/v1/messages');
    expect(normalizeProxyPath('/v1/v1/models')).toBe('/v1/models');
  });
  it('collapses /v1 appended after a pack segment (base ends in /v1/<pack>)', () => {
    // The exact failure: base_url = .../v1/stealth-requesty, client appends /v1/messages.
    expect(normalizeProxyPath('/v1/stealth-requesty/v1/messages')).toBe('/v1/stealth-requesty/messages');
    expect(normalizeProxyPath('/v1/stealth-requesty/v1/models')).toBe('/v1/stealth-requesty/models');
    expect(normalizeProxyPath('/v1/stealth-requesty/v1/chat/completions')).toBe('/v1/stealth-requesty/chat/completions');
  });
  it('strips trailing slashes', () => {
    expect(normalizeProxyPath('/v1/models/')).toBe('/v1/models');
  });
});

describe('extractEdgeToken', () => {
  it('reads X-Edge-Auth', () => {
    expect(extractEdgeToken({ 'x-edge-auth': 'edge_1' })).toBe('edge_1');
  });
  it('handles array-valued headers', () => {
    expect(extractEdgeToken({ 'x-edge-auth': ['edge_2'] })).toBe('edge_2');
  });
  it('returns null when absent', () => {
    expect(extractEdgeToken({})).toBeNull();
  });
  it('returns null when blank', () => {
    expect(extractEdgeToken({ 'x-edge-auth': '   ' })).toBeNull();
  });
});

describe('isEdgeAuthorized', () => {
  const tokens = parseAccessTokens('edge_good_1,edge_good_2');
  it('is OPEN when the allow-list is empty (layer disabled)', () => {
    expect(isEdgeAuthorized({}, new Set())).toBe(true);
    expect(isEdgeAuthorized({ 'x-edge-auth': 'anything' }, new Set())).toBe(true);
  });
  it('allows a request carrying a listed token', () => {
    expect(isEdgeAuthorized({ 'x-edge-auth': 'edge_good_1' }, tokens)).toBe(true);
  });
  it('rejects a missing or unlisted token when the layer is on', () => {
    expect(isEdgeAuthorized({}, tokens)).toBe(false);
    expect(isEdgeAuthorized({ 'x-edge-auth': 'nope' }, tokens)).toBe(false);
  });
});

describe('buildWafRuleExpression', () => {
  it('builds a single-token authorization rule with host', () => {
    expect(buildWafRuleExpression({ host: 'llm.example.com', tokens: ['abc'], header: 'authorization' })).toBe(
      '(http.host eq "llm.example.com" and http.request.method ne "OPTIONS" and not any(http.request.headers["authorization"][*] eq "Bearer abc"))'
    );
  });
  it('builds a single-token authorization rule without host', () => {
    expect(buildWafRuleExpression({ tokens: ['abc'], header: 'authorization' })).toBe(
      '(http.request.method ne "OPTIONS" and not any(http.request.headers["authorization"][*] eq "Bearer abc"))'
    );
  });
  it('builds an OR chain for multiple tokens', () => {
    const expr = buildWafRuleExpression({ tokens: ['t1', 't2'], header: 'authorization' });
    expect(expr).toBe(
      '(http.request.method ne "OPTIONS" and not (any(http.request.headers["authorization"][*] eq "Bearer t1") or any(http.request.headers["authorization"][*] eq "Bearer t2")))'
    );
  });
  it('uses the raw token value (no Bearer prefix) for x-edge-auth', () => {
    const expr = buildWafRuleExpression({ tokens: ['t1'], header: 'x-edge-auth' });
    expect(expr).toBe(
      '(http.request.method ne "OPTIONS" and not any(http.request.headers["x-edge-auth"][*] eq "t1"))'
    );
  });
  it('always includes method ne "OPTIONS"', () => {
    expect(buildWafRuleExpression({ tokens: ['t1'], header: 'authorization' })).toContain(
      'http.request.method ne "OPTIONS"'
    );
    expect(buildWafRuleExpression({ host: 'h', tokens: ['t1', 't2'], header: 'x-edge-auth' })).toContain(
      'http.request.method ne "OPTIONS"'
    );
  });
  it('lowercases the header name in the output', () => {
    expect(buildWafRuleExpression({ tokens: ['t1'], header: 'authorization' })).toContain(
      '"authorization"'
    );
  });
  it('throws on empty tokens', () => {
    expect(() => buildWafRuleExpression({ tokens: [], header: 'authorization' })).toThrow();
  });
});
