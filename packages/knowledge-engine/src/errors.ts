/**
 * Thrown by an {@link IKnowledgeProvider} method the backend genuinely cannot
 * implement (e.g. `supersede` on a plain vector store). Callers can tell it
 * apart from a transport/runtime failure and route around it.
 */
export class KnowledgeNotSupportedError extends Error {
  readonly engine: string
  readonly operation: string

  constructor(engine: string, operation: string, detail?: string) {
    super(
      `${engine}: ${operation}() is not supported by this backend` +
        (detail ? ` — ${detail}` : ""),
    )
    this.name = "KnowledgeNotSupportedError"
    this.engine = engine
    this.operation = operation
  }
}
