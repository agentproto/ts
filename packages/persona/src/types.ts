/**
 * AIP-25 PersonaDefinition + PersonaHandle.
 *
 * `PersonaDefinition` was generated from
 * `resources/aip-25/draft/PERSONA.schema.json` via json-schema-to-typescript.
 * `PersonaHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-25 PERSONA.md manifest. Single-doc, no oneOf — every persona is the same shape. The body is markdown and not validated by this schema.
 */
export interface PersonaDefinition {
  /**
   * Schema dispatch tag. MUST be 'persona/v1' for this version of AIP-25.
   */
  schema: "persona/v1"
  /**
   * Machine identifier. Lowercase, digits, dashes. Must start with a letter, end with a letter or digit. Unique within the registry that hosts the persona.
   */
  name: string
  /**
   * Human-readable display title, sentence case.
   */
  title: string
  /**
   * One-paragraph elevator pitch. The persona's purpose, audience, and shape.
   */
  description: string
  /**
   * Semver. Bump on breaking change to identity, voice, or boundaries.
   */
  version: string
  /**
   * Relative path to a parent PERSONA.md. Triggers composition. Path MUST end in 'PERSONA.md'.
   */
  extends?: string
  /**
   * Public visual face. URL, data URI, or 'ws://avatars/<slug>' ref. Schema does not validate scheme; the loader resolves.
   */
  avatar?: string
  backstory?: {
    /**
     * Punchy elevator hook. One sentence the catalog can show next to the persona name.
     */
    oneLineHook?: string
    /**
     * Long-form lore prose, in markdown. The character's history, motivations, and context.
     */
    background?: string
    /**
     * Categorical archetype labels. Lowercase kebab-case. Examples: mentor, craftsman, sentinel, trickster. The catalog MAY cluster by these.
     *
     * @maxItems 12
     */
    archetypes?:
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
     * Free-form era label. Conventional values: 'contemporary', 'timeless', '<year>', '<year>-<year>', '<period>'. Free-form to accept any setting.
     */
    era?: string
    /**
     * Free-form setting label. Conventional values: 'real-world', 'fictional-<universe>'. Free-form to accept any setting.
     */
    setting?: string
  }
  voice?: {
    /**
     * Voice register. Conventional values: warm-direct, playful, terse, academic. Custom values welcome — free-form to accept any author label.
     */
    register?: string
    /**
     * Catchphrases the character uses. Append-and-dedupe under extends — lineage accumulates phrases.
     *
     * @maxItems 24
     */
    signaturePhrases?: string[]
    /**
     * Tonal adjectives. Examples: rigorous, encouraging, dry, warm. Append-and-dedupe under extends.
     *
     * @maxItems 16
     */
    tonality?:
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
      | [string, string, string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
    /**
     * Formality scale, 0 (extremely casual) to 10 (extremely formal). Optional.
     */
    formality?: number
    /**
     * Emoji posture. 'never' = no emojis ever; 'sparing' = occasional, intentional; 'frequent' = part of the voice.
     */
    emojiUsage?: "never" | "sparing" | "frequent"
    /**
     * Sign-off the persona uses to close messages. Examples: '—M.', 'Yours, Marcus', 'Until next time'.
     */
    signOff?: string
  }
  boundaries?: {
    /**
     * Topics the persona refuses outright. Free-form prose; the persona body SHOULD demonstrate the refusal posture in voice samples. Append-and-dedupe under extends.
     */
    refuses?: string[]
    /**
     * Topics the persona defers to a specialist on. Append-and-dedupe under extends.
     */
    defers?: string[]
    /**
     * Topic-to-target redirects. Merge-by-`topic` under extends — child entry with same topic replaces parent's.
     */
    redirects?: {
      /**
       * The topic the persona redirects.
       */
      topic: string
      /**
       * Redirect target. ws:// ref to a persona/operator/skill, or a relative path.
       */
      to: string
      /**
       * Optional prose describing why the redirect exists.
       */
      notes?: string
    }[]
  }
  /**
   * BCP-47 locale tag. Examples: 'en', 'en-US', 'fr-FR', 'pt-BR'.
   */
  defaultLocale?: string
  /**
   * Fallback locales. BCP-47. Append-and-dedupe under extends.
   *
   * @maxItems 32
   */
  multilingual?: string[]
  /**
   * Named relationships to other personas. Merge-by-`persona` under extends — child entry with same ref replaces parent's.
   */
  relationships?: {
    /**
     * ws:// ref to another persona/v1 manifest in the registry.
     */
    persona: string
    /**
     * Relationship kind. Conventional values: mentor-of, peer-of, mentee-of, rival-of, partner-of. Free-form to accept any author label.
     */
    kind: string
    /**
     * Optional prose describing the relationship.
     */
    notes?: string
  }[]
  /**
   * Optional AIP-23 identity workspace ref. The persona's inner substance.
   */
  identity?: string
  /**
   * Bind this persona to specific consumers. Local-only — not inherited under extends.
   */
  appliesTo?: string[]
  /**
   * Catalog tags. Lowercase kebab-case. Append-and-dedupe under extends.
   *
   * @maxItems 16
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
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
  /**
   * Vendor extensions, namespaced under <vendor>. Hosts MUST tolerate unknown keys; vendor namespaces MUST NOT override the meaning of fields defined in this AIP.
   */
  metadata?: {
    [k: string]: unknown
  }
}

export type PersonaHandle = Readonly<PersonaDefinition>
