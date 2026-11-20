/**
 * Scribe sometimes answers a quiet chunk with a stock training-data subtitle
 * credit. Without a filter every moment of silence becomes a phantom user
 * turn. Patterns from the studio voice server
 * (`packages/agent-framework/src/voice/start-voice-server.ts:2244-2256`).
 */
export const SCRIBE_HALLUCINATION_PATTERNS: readonly RegExp[] = [
  /sous-titres?\s+r[ée]alis[ée]s?\s+par/i,
  /amara\.org/i,
  /thanks?\s+for\s+watching/i,
  /subscribe\s+to\s+(my|the)\s+channel/i,
]

export function isScribeHallucination(text: string): boolean {
  return SCRIBE_HALLUCINATION_PATTERNS.some(rx => rx.test(text))
}
