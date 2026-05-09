/**
 * AIP-3 SkillDefinition + SkillHandle.
 *
 * Mirrors `resources/aip-3/draft/SKILL.schema.json`. AIP-3 is a profile
 * of agentskills.io: top-level fields are the canonical agentskills.io
 * frontmatter; AIP-3 extensions live under `metadata.aip3.*`.
 *
 * `SkillHandle` is the readonly view of the same shape; tighten it by
 * hand for fields that get defaults applied in build().
 */

export type SkillVariant = "instruction" | "executable" | "composite"

export type SkillExecutionLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "shell"

export interface SkillExecution {
  /** Implementation language. */
  language: SkillExecutionLanguage
  /** Exactly one of { file } or { inline }. */
  code: { file: string } | { inline: string }
  /** Optional function name within the entry file. */
  entrypoint?: string
  /** Optional runtime hints (provider, timeout, memory). */
  runtime?: {
    provider?: string
    timeout?: number
    memory?: string
  }
  /** Glob patterns of output files the runtime should capture. */
  artifacts?: { patterns: string[] }
  /** Package -> version map. */
  dependencies?: Record<string, string>
}

/** AIP-3 extensions to the agentskills.io baseline. Lives under `metadata.aip3`. */
export interface Aip3Extensions {
  /** Schema dispatch tag. Required for AIP-3 conformance. */
  schema: "skills/v1"
  /** Skill variant. Defaults to "instruction" when omitted. */
  variant?: SkillVariant
  /** Semver. */
  version?: string
  /** Catalog tags. Lowercase kebab-case. */
  tags?: string[]
  /** Coarse grouping. Free-form. */
  category?: string
  /** Other AIPs this skill depends on (e.g. [9] for the operator runtime). */
  requires?: number[]
  /** Author identifier. */
  author?: string
  /** Optional human-readable display title (body H1 preferred). */
  title?: string
  /** Skill names this skill composes with. Non-empty when variant=composite. */
  uses?: string[]
  /** Executable bindings. Required when variant=executable. */
  execution?: SkillExecution
  /** AIP-3 extensions stay open: vendors MAY add namespaced sub-keys. */
  [extension: string]: unknown
}

/**
 * AIP-3 SKILL.md frontmatter. The top-level fields mirror
 * agentskills.io 1:1 so AIP-3 skills are valid agentskills.io skills.
 */
export interface SkillDefinition {
  /** Machine identifier — kebab, 1–64 chars, matches parent dir. */
  name: string
  /** One-paragraph purpose, written for the LLM caller. ≤1024 chars. */
  description: string
  /** Optional license identifier or pointer to a bundled license file. */
  license?: string
  /** Optional environment requirements. */
  compatibility?: string
  /** Optional space-separated tool allowlist. Request, not grant. */
  "allowed-tools"?: string
  /**
   * Free-form key-value map. Houses AIP-3 extensions at
   * `metadata.aip3` and any vendor-namespaced extras.
   */
  metadata?: {
    aip3?: Aip3Extensions
    [vendor: string]: unknown
  }
  /** Top-level extension surface preserved for forward compatibility. */
  [extension: string]: unknown
}

export type SkillHandle = Readonly<SkillDefinition>
