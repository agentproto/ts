/**
 * AIP-3 SkillDefinition + SkillHandle.
 *
 * `SkillDefinition` was generated from
 * `resources/aip-3/draft/SKILL.schema.json` via json-schema-to-typescript.
 * `SkillHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-3 SKILL.md manifest. Note: this very schema is also exercised by the AIP-3 authoring SKILL.md in the same folder — the authoring skill is itself a valid AIP-3 skill and validates against this file.
 */
export type SkillDefinition = {
  [k: string]: unknown
} & {
  /**
   * Schema dispatch tag. MUST be 'skills/v1' for this version of AIP-3.
   */
  schema: "skills/v1"
  /**
   * Machine identifier. Lowercase, digits, dashes. Must start with a letter, end with a letter or digit.
   */
  name: string
  /**
   * Human-readable display title, sentence case.
   */
  title: string
  /**
   * One-paragraph purpose, written for the LLM caller. Used by the host catalog for skill selection.
   */
  description: string
  /**
   * Semver. Bump on breaking change to inputs or required tools.
   */
  version: string
  /**
   * Optional. Conventional shape: 'Name <email>'.
   */
  author?: string
  /**
   * Optional. Relative path to an entry file (e.g. skill.ts) exposing defineSkill. Body-only skills omit this.
   */
  entry?: string
  /**
   * Catalog tags. Lowercase kebab-case; no leading symbols. 3-6 tags is typical.
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
  inputs?: {
    /**
     * Parameter identifier. camelCase or snake_case.
     */
    name: string
    /**
     * Input type. Richer shapes go in the body as guidance.
     */
    type: "string" | "number" | "boolean" | "object"
    required?: boolean
    /**
     * Prose for the LLM. Empty descriptions train the agent to hallucinate.
     */
    description: string
    /**
     * Optional default value when 'required' is false.
     */
    default?: {
      [k: string]: unknown
    }
  }[]
  /**
   * Optional. JSON Schema (draft 2020-12) describing the structured output the skill reports back, if any. Most skills return prose only and omit this field.
   */
  outputs?: {}
  /**
   * Tool ids the skill expects to find in the host's catalog. Declarative — the body still drives invocation.
   */
  tools?: string[]
  /**
   * Other skills this skill composes with. The host MAY refuse activation if any are absent.
   */
  skills?: string[]
  /**
   * Host capabilities the skill needs. Gated by AIP-7 before activation.
   */
  capabilities?: {
    network?: string[]
    "fs.read"?: string[]
    "fs.write"?: string[]
    env?: string[]
    secrets?: string[]
    tools?: string[]
  }
  /**
   * Optional sample invocations. The host MAY use these as registration-time tests.
   */
  examples?: {
    name?: string
    input: unknown
    output?: unknown
    note?: string
  }[]
  install?: {
    /**
     * Default install scope hint. Hosts MAY override based on policy.
     */
    scope?: "workspace" | "user" | "host"
    /**
     * Optional custom install path; defaults to '<scope-root>/.skills/<name>/'.
     */
    path?: string
  }
  /**
   * Host-specific extension fields. Authors stash hints under namespaced keys (e.g. metadata.acme.foo).
   */
  metadata?: {
    [k: string]: unknown
  }
}

export type SkillHandle = Readonly<SkillDefinition>
