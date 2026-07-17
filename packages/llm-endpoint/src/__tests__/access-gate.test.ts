import { describe, it, expect } from 'vitest';
import {
  parseAccessTokens,
  extractInboundToken,
  isAuthorized,
  normalizeProxyPath,
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
    expect(extractInboundToken({ authorization: ['Bearer tok_4'] })).toBe('tok_4');
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
