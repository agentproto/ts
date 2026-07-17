/**
 * Empty-turn retry.
 *
 * Some reasoning models served behind a router (verified: Requesty on
 * sference/thinkingcap-qwen3.6-27b, ~12% of turns, measured identically on both
 * that router's Anthropic and OpenAI surfaces — so it is a model defect, not a
 * translation one) reason and then emit NOTHING: thinking blocks only, no text,
 * no tool_use, `stop_reason: "end_turn"`. Since the proxy strips thinking, the
 * client receives an empty message and the turn is a silent no-op.
 *
 * These tests pin the DECISION (what counts as an empty turn, and how many
 * replays are budgeted). The wire-level replay itself is covered by the live
 * e2e, which measured the drop rate through the proxy before/after.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { isEmptyAnthropicTurn, resolveEmptyTurnRetries } from '../index.js';

const ORIGINAL = process.env.LLM_ENDPOINT_EMPTY_TURN_RETRY;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.LLM_ENDPOINT_EMPTY_TURN_RETRY;
  else process.env.LLM_ENDPOINT_EMPTY_TURN_RETRY = ORIGINAL;
});

const msg = (over: Record<string, unknown>) =>
  JSON.stringify({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [], ...over });

describe('isEmptyAnthropicTurn', () => {
  it('flags a thinking-only end_turn (the live failure shape)', () => {
    // Verbatim shape observed from Requesty on sference/*.
    expect(
      isEmptyAnthropicTurn(
        msg({ content: [{ type: 'thinking', thinking: 'I should call get_weather.', signature: '' }] })
      )
    ).toBe(true);
  });

  it('flags an entirely empty content array', () => {
    expect(isEmptyAnthropicTurn(msg({ content: [] }))).toBe(true);
  });

  it('does NOT flag a turn carrying text', () => {
    expect(isEmptyAnthropicTurn(msg({ content: [{ type: 'text', text: 'PONG' }] }))).toBe(false);
  });

  it('does NOT flag a turn carrying a tool_use, even alongside thinking', () => {
    expect(
      isEmptyAnthropicTurn(
        msg({
          stop_reason: 'tool_use',
          content: [
            { type: 'thinking', thinking: '…', signature: '' },
            { type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'Paris' } },
          ],
        })
      )
    ).toBe(false);
  });

  it('does NOT flag a max_tokens truncation', () => {
    // The model burned its budget inside the thinking block. Replaying with the
    // same budget reproduces it and bills twice — that is a config problem
    // (raise max_tokens), not the empty-turn defect.
    expect(
      isEmptyAnthropicTurn(
        msg({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '…', signature: '' }] })
      )
    ).toBe(false);
  });

  it('does NOT flag an upstream error body', () => {
    expect(isEmptyAnthropicTurn(JSON.stringify({ type: 'error', error: { message: 'rate limited' } }))).toBe(false);
  });

  it('does NOT flag malformed JSON (fails closed — no replay)', () => {
    expect(isEmptyAnthropicTurn('not json')).toBe(false);
    expect(isEmptyAnthropicTurn('')).toBe(false);
  });
});

describe('resolveEmptyTurnRetries', () => {
  it('defaults to one replay', () => {
    delete process.env.LLM_ENDPOINT_EMPTY_TURN_RETRY;
    expect(resolveEmptyTurnRetries()).toBe(1);
  });

  it('honours an explicit 0 as opt-out', () => {
    process.env.LLM_ENDPOINT_EMPTY_TURN_RETRY = '0';
    expect(resolveEmptyTurnRetries()).toBe(0);
  });

  it('honours a raised budget', () => {
    process.env.LLM_ENDPOINT_EMPTY_TURN_RETRY = '2';
    expect(resolveEmptyTurnRetries()).toBe(2);
  });

  it('falls back to the default on garbage or negative values', () => {
    process.env.LLM_ENDPOINT_EMPTY_TURN_RETRY = 'yes-please';
    expect(resolveEmptyTurnRetries()).toBe(1);
    process.env.LLM_ENDPOINT_EMPTY_TURN_RETRY = '-3';
    expect(resolveEmptyTurnRetries()).toBe(1);
  });
});
