import { describe, expect, it } from 'vitest';
import { checkHarnessFit, DEFAULT_HEADROOM_RATIO, HARNESS_FIRST_REQUEST_SIZE } from '../harness-fit.js';

// Pure-function fit-check math — no server, no fs, no network.

describe('checkHarnessFit', () => {
  it('fits when the loaded ctx clears the required tokens plus headroom', () => {
    const result = checkHarnessFit({ harness: 'pi', loadedCtx: 32_768 });
    expect(result.verdict).toBe('fits');
    expect(result.requiredTokens).toBe(HARNESS_FIRST_REQUEST_SIZE.pi!.tokens);
    expect(result.message).toBeUndefined();
  });

  it('matches the plan\'s own worked example: claude-code (~36k) against a 32k endpoint does not fit, needs >= 48k', () => {
    const result = checkHarnessFit({
      harness: 'claude-code',
      loadedCtx: 32_768,
      endpointLabel: 'lmstudio@win-pc',
    });
    expect(result.verdict).toBe('no-fit');
    expect(result.thresholdTokens).toBe(47_900); // ceil(35925 / 0.75)
    expect(result.message).toContain('claude-code');
    expect(result.message).toContain('lmstudio@win-pc');
    expect(result.message).toContain('pi');
    expect(result.message).toContain('48k');
  });

  it('fits claude-code against an endpoint loaded comfortably above the threshold', () => {
    const result = checkHarnessFit({ harness: 'claude-code', loadedCtx: 82_944 });
    expect(result.verdict).toBe('fits');
  });

  it('is a boundary check at exactly the threshold', () => {
    const required = HARNESS_FIRST_REQUEST_SIZE['claude-code']!.tokens;
    const threshold = Math.ceil(required / (1 - DEFAULT_HEADROOM_RATIO));
    expect(checkHarnessFit({ harness: 'claude-code', loadedCtx: threshold }).verdict).toBe('fits');
    expect(checkHarnessFit({ harness: 'claude-code', loadedCtx: threshold - 1 }).verdict).toBe('no-fit');
  });

  it('returns unknown (never blocks) for a harness with no measured first-request size', () => {
    const result = checkHarnessFit({ harness: 'opencode', loadedCtx: 32_768 });
    expect(result.verdict).toBe('unknown');
    expect(result.requiredTokens).toBeUndefined();
    expect(result.message).toContain('opencode');
  });

  it('returns unknown (never blocks) when the endpoint reports no loaded ctx (e.g. Ollama)', () => {
    const result = checkHarnessFit({ harness: 'pi', loadedCtx: undefined, endpointLabel: 'ollama@work-mac' });
    expect(result.verdict).toBe('unknown');
    expect(result.requiredTokens).toBe(HARNESS_FIRST_REQUEST_SIZE.pi!.tokens);
    expect(result.message).toContain('ollama@work-mac');
  });

  it('honors a custom headroom ratio', () => {
    const zeroHeadroom = checkHarnessFit({ harness: 'pi', loadedCtx: HARNESS_FIRST_REQUEST_SIZE.pi!.tokens, headroomRatio: 0 });
    expect(zeroHeadroom.verdict).toBe('fits');
    expect(zeroHeadroom.thresholdTokens).toBe(HARNESS_FIRST_REQUEST_SIZE.pi!.tokens);

    const bigHeadroom = checkHarnessFit({ harness: 'pi', loadedCtx: HARNESS_FIRST_REQUEST_SIZE.pi!.tokens, headroomRatio: 0.5 });
    expect(bigHeadroom.verdict).toBe('no-fit');
  });

  it('every table entry carries a non-empty source citation', () => {
    for (const [harness, entry] of Object.entries(HARNESS_FIRST_REQUEST_SIZE)) {
      expect(entry.tokens, harness).toBeGreaterThan(0);
      expect(entry.source, harness).not.toBe('');
    }
  });
});
