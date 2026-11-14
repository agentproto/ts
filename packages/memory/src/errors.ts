import type { MemoryIssue } from "./types.js"

/** Thrown by `defineMemory` and `renderMemory` on an invalid item. */
export class MemoryValidationError extends Error {
  /** Every error found, each naming its field path. */
  readonly issues: readonly MemoryIssue[]
  /** Path of the first offending field (`""` for the whole document). */
  readonly field: string

  constructor(prefix: string, issues: readonly MemoryIssue[]) {
    super(
      `${prefix}: ${issues
        .map((i) => `${i.path || "(document)"}: ${i.message}`)
        .join("; ")}`,
    )
    this.name = "MemoryValidationError"
    this.issues = issues
    this.field = issues[0]?.path ?? ""
  }
}

/** Thrown by `parseMemory` when the markdown has no readable frontmatter. */
export class MemoryParseError extends Error {
  constructor(message: string) {
    super(`parseMemory (AIP-72): ${message}`)
    this.name = "MemoryParseError"
  }
}
