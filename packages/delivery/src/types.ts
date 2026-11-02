/** 3 blocking, 2 actionable, 1 info, 0 noise. */
export type Level = 0 | 1 | 2 | 3

/** The claims that pin level 3. A producer sets at most one. */
export type Floor = "awaiting-human" | "crash"

/** Delivery tier a level maps to. */
export type Tier = "steer" | "next-turn" | "fyi" | "drop"

/** The one event shape every producer emits. No producer-specific field. */
export interface Envelope {
  readonly specversion: "1.0"
  /** Stable across retries. Dedup key is (source, id). */
  readonly id: string
  /** Producer instance URI, e.g. "agentproto:sentinel/sen_x". */
  readonly source: string
  /** `<scheme>.<object>.<action>`, lowercase, dots only. */
  readonly type: string
  /** `<scheme>:<path>`. */
  readonly subject: string
  /** Full hierarchy, most specific first. */
  readonly subjects: readonly string[]
  /** ISO 8601. */
  readonly time: string
  /** One line, used verbatim as inbox text. */
  readonly summary: string
  /** Normalized projection. The kernel never reads it; classifiers may. */
  readonly data: Record<string, unknown>
  /** Ends the subject's lifecycle. Affects subscription lifetime only, never level. */
  readonly terminal: boolean

  /** Pins level 3. Set by the producer only when the claim is true. */
  readonly floor?: Floor
  /** Producer's level claim. A classifier may lower or raise it; the floor wins. */
  readonly levelHint?: Level
  /** Repeat and queue-coalesce key. Absent: the envelope never coalesces. */
  readonly repeatKey?: string
  /** Sessions this envelope is about, so classifiers never read `data` for them. */
  readonly about?: { readonly sessionId?: string; readonly actorSessionId?: string }
}

export interface ClassifyContext {
  readonly targetId: string
  /** Facts the runtime knows and the envelope does not carry. */
  readonly facts: {
    reportedRecently(sessionId: string, targetId: string, windowMs: number): boolean
    isDescendant(sessionId: string, ancestorId: string): boolean
    cronOutcome(sessionId: string): boolean | undefined
    supersededByNewTurn(sessionId: string, turnTs: string): boolean
  }
}

export interface Classifier {
  /** Stable id, recorded in the ledger as `rule`. */
  readonly id: string
  /** Type globs: exact, or a prefix ending in `*`. First registered match wins. */
  readonly types: readonly string[]
  /** A level, or undefined to decline. */
  classify(env: Envelope, ctx: ClassifyContext): Level | undefined
  /** Optional queue-coalesce key when the producer did not set `repeatKey`. */
  repeatKey?(env: Envelope): string | undefined
}

export interface ClassifierRegistry {
  /** Registers a classifier; the same `id` replaces in place. Returns an unregister function. */
  register(c: Classifier): () => void
  /** First registered classifier whose type globs cover the envelope, or undefined. */
  match(env: Envelope): Classifier | undefined
  /** First non-declining match; no match is `{ level: levelHint ?? 2, rule: "default" }`. */
  classify(env: Envelope, ctx: ClassifyContext): { level: Level; rule: string }
  list(): readonly Classifier[]
}
