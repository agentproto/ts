/**
 * AIP-28 IntentDefinition + IntentHandle.
 *
 * `IntentDefinition` was generated from
 * `resources/aip-28/draft/INTENT.schema.json` via json-schema-to-typescript.
 * `IntentHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Either a plain string (treated as locale `en`) or a per-locale map keyed by BCP-47.
 */
export type I18NString =
  | string
  | {
      [k: string]: string
    }
export type ImplementsEntry = {
  tool?: string
  workflow?: string
  entry?: string
  default?: boolean
  when?: {
    [k: string]: PredicateValue
  }
  mapping?: {
    [k: string]: MappingValue
  }
} & ImplementsEntry1 & {
    tool?: string
    workflow?: string
    entry?: string
    default?: boolean
    when?: {
      [k: string]: PredicateValue
    }
    mapping?: {
      [k: string]: MappingValue
    }
  } & ImplementsEntry1 & {
    tool?: string
    workflow?: string
    entry?: string
    default?: boolean
    when?: {
      [k: string]: PredicateValue
    }
    mapping?: {
      [k: string]: MappingValue
    }
  } & ImplementsEntry1 & {
    tool?: string
    workflow?: string
    entry?: string
    default?: boolean
    when?: {
      [k: string]: PredicateValue
    }
    mapping?: {
      [k: string]: MappingValue
    }
  } & ImplementsEntry1
/**
 * Value shape for `when` and `depends_on`. Literal value, or comparison object.
 */
export type PredicateValue =
  | unknown
  | {
      not?: unknown
      in?: unknown[]
      not_in?: unknown[]
      not_empty?: boolean
      gt?: number
      lt?: number
      gte?: number
      lte?: number
    }
export type MappingValue =
  | string
  | {
      from: string
      /**
       * Named transformer exported by the entry.
       */
      transform?: string
    }
export type ImplementsEntry1 =
  | {
      [k: string]: unknown
    }
  | {
      [k: string]: unknown
    }
  | {
      [k: string]: unknown
    }

/**
 * JSON Schema for the YAML frontmatter of an AIP-28 INTENT.md manifest.
 */
export interface IntentDefinition {
  /**
   * Internal display name.
   */
  name:
    | string
    | {
        [k: string]: string
      }
  id: string
  /**
   * User-facing button/menu label.
   */
  label:
    | string
    | {
        [k: string]: string
      }
  /**
   * User-facing copy (≤500 chars per locale).
   */
  description:
    | string
    | {
        [k: string]: string
      }
  version: string
  /**
   * Natural-language seeds an LLM matches against.
   */
  intent:
    | [string, ...string[]]
    | {
        /**
         * @minItems 1
         */
        [k: string]: [string, ...string[]]
      }
  /**
   * @minItems 0
   */
  surfaces: ("chat" | "menu" | "voice" | "shortcut" | "api")[]
  inputs?: InputField[]
  outputs?: Outputs
  /**
   * Workspace-relative path to a routing implementation.
   */
  entry?: string
  /**
   * @minItems 1
   */
  implements: [ImplementsEntry, ...ImplementsEntry[]]
  cost_class?: "trivial" | "metered" | "expensive"
  quota_key?: string
  requires?: Capabilities
  /**
   * Workspace-relative path to a SECRETS.md (AIP-19).
   */
  auth?: string
  experiments?: ExperimentArm[]
  preview?: string
  tags?: string[]
  examples?: {
    user: I18NString
    note?: I18NString
  }[]
  metadata?: {}
}
export interface InputField {
  name: string
  label: I18NString
  type:
    | "text"
    | "textarea"
    | "number"
    | "toggle"
    | "choice"
    | "multi-choice"
    | "file"
    | "image"
    | "date"
    | "markdown"
    | "code"
    | "ref"
  placeholder?: I18NString
  hint?: I18NString
  required?: boolean
  default?: unknown
  min?: number
  max?: number
  min_length?: number
  max_length?: number
  pattern?: string
  /**
   * For choice / multi-choice. Either a list of strings or a list of {value,label} objects.
   */
  values?:
    | string[]
    | {
        value: unknown
        label: I18NString
      }[]
  accept?: string[]
  language?: string
  depends_on?: {
    [k: string]: unknown
  }
}
export interface Outputs {
  type: "text" | "image" | "markdown" | "file" | "custom"
  template?: string
}
export interface Capabilities {
  network?: string[]
  secrets?: string[]
  tools?: string[]
}
export interface ExperimentArm {
  id: string
  weight: number
  when?: {
    [k: string]: PredicateValue
  }
  /**
   * @minItems 1
   */
  implements: [ImplementsEntry, ...ImplementsEntry[]]
}

export type IntentHandle = Readonly<IntentDefinition>
