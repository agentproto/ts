/**
 * AIP-11 LessonDefinition + LessonHandle.
 *
 * `LessonDefinition` was generated from
 * `resources/aip-11/draft/LESSON.schema.json` via json-schema-to-typescript.
 * `LessonHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-11 LESSON.md file — one transferable lesson distilled from a completed run.
 */
export type LessonDefinition = {
  [k: string]: unknown
} & {
  /**
   * Spec identifier. Must be the literal string 'learning/v1'.
   */
  schema: "learning/v1"
  /**
   * Machine identifier, also the filename. Lowercase, digits, dashes. Imperative voice recommended.
   */
  slug: string
  /**
   * One-sentence imperative title — what to do or avoid.
   */
  title: string
  trigger: {
    /**
     * Plain-text description of when this lesson applies.
     */
    description: string
    /**
     * Retrieval keywords. Keep narrow; three is usually enough.
     *
     * @maxItems 12
     */
    tags?:
      | []
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string]
    /**
     * Operator / role / skill globs that scope retrieval. Empty means anyone.
     */
    targets?: {
      operator?: string
      role?: string
      skill?: string
    }[]
    /**
     * Vendor-specific trigger predicates. Standard fields above MUST NOT be redefined here.
     */
    metadata?: {
      [k: string]: unknown
    }
  }
  /**
   * Whether the source run succeeded, failed, or the lesson is conditional across runs.
   */
  outcome: "success" | "failure" | "mixed"
  /**
   * Provenance — at least one evidence entry MUST resolve to a real run, conversation, work item, audit, or wiki page in the host's indices.
   *
   * @minItems 1
   */
  evidence: [
    {
      /**
       * What the evidence reference points to. 'audit' = AIP-7 governance record.
       */
      kind: "run" | "conversation" | "work-item" | "audit" | "wiki-page"
      /**
       * Opaque id or path the host can resolve. Never free text.
       */
      ref: string
      /**
       * One-line factual note about the event — not the lesson.
       */
      note?: string
    },
    ...{
      /**
       * What the evidence reference points to. 'audit' = AIP-7 governance record.
       */
      kind: "run" | "conversation" | "work-item" | "audit" | "wiki-page"
      /**
       * Opaque id or path the host can resolve. Never free text.
       */
      ref: string
      /**
       * One-line factual note about the event — not the lesson.
       */
      note?: string
    }[]
  ]
  /**
   * Author's confidence in [0,1]. Default 0.5 at first sighting. Runtimes weigh this against observed counts.
   */
  confidence?: number
  /**
   * Times the lesson 'worked' when applied. Maintained by the runtime; author-supplied values are initial only.
   */
  success_count?: number
  /**
   * Times the lesson's claim was contradicted. Maintained by the runtime; author-supplied values are initial only.
   */
  failure_count?: number
  /**
   * Slugs of lessons this lesson replaces. Supersession is explicit, never silent. Each cited slug MUST exist on disk.
   */
  supersedes?: string[]
  /**
   * Soft TTL (ISO 8601). Past this instant, retrieval treats the lesson as absent by default.
   */
  expires_at?: string
  /**
   * Vendor-specific extensions under namespaced keys (metadata.<vendor>.<field>). Standard fields MUST NOT be redefined.
   */
  metadata?: {
    [k: string]: unknown
  }
}

export type LessonHandle = Readonly<LessonDefinition>
