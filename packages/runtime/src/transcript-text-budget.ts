/**
 * Shared byte accounting for transcript text ceilings.
 *
 * Both transcript sources the workspace brain can read (`events.jsonl` via
 * `exportDaemonEventsSession`, and a provider-native store) must count the
 * SAME fields, or a native session with large reasoning/tool-call payloads
 * slips past a ceiling the daemon-events path would have enforced. This module
 * owns that definition once: a message's `text`, its `reasoning`, and every
 * `toolCalls[].args`.
 */

export type TranscriptTooLargeReason = "file-size" | "text-size"

/** Thrown when a caller passes a ceiling and the transcript exceeds it. */
export class TranscriptTooLargeError extends Error {
  readonly reason: TranscriptTooLargeReason
  readonly sizeBytes: number
  readonly ceilingBytes: number

  constructor(
    reason: TranscriptTooLargeReason,
    sizeBytes: number,
    ceilingBytes: number,
    sessionId: string,
  ) {
    super(
      `daemon-events: transcript for session "${sessionId}" is too large ` +
        `(${reason}: ${sizeBytes} bytes > ${ceilingBytes} byte ceiling)`,
    )
    this.name = "TranscriptTooLargeError"
    this.reason = reason
    this.sizeBytes = sizeBytes
    this.ceilingBytes = ceilingBytes
  }
}

/** The fields a transcript message contributes to the text ceiling. */
export interface TextBearingMessage {
  readonly text?: string
  readonly reasoning?: string
  readonly toolCalls?: ReadonlyArray<{ readonly args: string }>
}

/**
 * A running counter with an optional ceiling. `add()` throws
 * {@link TranscriptTooLargeError} as soon as the accumulated text crosses the
 * ceiling, so a parser can stop before building the rest of a transcript.
 */
export class TranscriptTextBudget {
  private bytes = 0

  constructor(
    private readonly ceilingBytes: number | undefined,
    private readonly sessionId: string,
  ) {}

  get sizeBytes(): number {
    return this.bytes
  }

  add(text: string | undefined): void {
    if (!text) return
    this.bytes += Buffer.byteLength(text, "utf8")
    if (this.ceilingBytes !== undefined && this.bytes > this.ceilingBytes) {
      throw new TranscriptTooLargeError(
        "text-size",
        this.bytes,
        this.ceilingBytes,
        this.sessionId,
      )
    }
  }

  /** Add every text-bearing field of one already-exported message. */
  addMessage(message: TextBearingMessage): void {
    this.add(message.text)
    this.add(message.reasoning)
    if (message.toolCalls) {
      for (const call of message.toolCalls) this.add(call.args)
    }
  }
}

/** Measure an already-materialized transcript with the same field set. */
export function measureMessageTextBytes(
  messages: readonly TextBearingMessage[],
): number {
  const budget = new TranscriptTextBudget(undefined, "")
  for (const message of messages) budget.addMessage(message)
  return budget.sizeBytes
}
