/**
 * AIP-42 AgentDefinition + AgentHandle.
 *
 * `AgentDefinition` was generated from
 * `resources/aip-42/draft/AGENT.schema.json` via json-schema-to-typescript.
 * `AgentHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * AIP-27 ref primitive — string shorthand or { ref | file | inline }.
 */
export type AnyRef =
  | string
  | {
      ref?: string
      file?: string
      inline?: {
        [k: string]: unknown
      }
    }
export type ActionRef =
  | string
  | {
      action?: string
      ref?: string
      inputs?: {
        [k: string]: unknown
      }
      [k: string]: unknown
    }
export type ModelRef =
  | string
  | {
      ref?: string
      inline?: {
        [k: string]: unknown
      }
      temperature?: number
      max_tokens?: number
      top_p?: number
      [k: string]: unknown
    }

/**
 * Validates the YAML frontmatter portion of an AIP-42 AGENT.md manifest. Composes identity, persona, model, tools, actions, skills, workflows, runner, memory, governance, policy, routines into a single runnable definition.
 */
export interface AgentDefinition {
  schema: "agent/v1"
  /**
   * Machine identifier. Optional @<owner>/ prefix. Unique within the registry that hosts the agent.
   */
  id: string
  /**
   * One-paragraph purpose.
   */
  description: string
  /**
   * Spec version of THIS file.
   */
  version?: string
  /**
   * Parent AGENT this extends. Inherits all fields; child overrides win.
   */
  extends?:
    | string
    | {
        ref?: string
        file?: string
        inline?: {
          [k: string]: unknown
        }
      }
  /**
   * The brain — provider/model id string or structured ref.
   */
  model:
    | string
    | {
        ref?: string
        inline?: {
          [k: string]: unknown
        }
        temperature?: number
        max_tokens?: number
        top_p?: number
        [k: string]: unknown
      }
  /**
   * AIP-23 identity ref. Defaults to host policy.
   */
  identity?:
    | string
    | {
        ref?: string
        file?: string
        inline?: {
          name?: string
          email?: string
        }
        [k: string]: unknown
      }
  /**
   * AIP-25 persona ref.
   */
  persona?:
    | string
    | {
        ref?: string
        file?: string
        inline?: {
          [k: string]: unknown
        }
      }
  /**
   * AIP-17 runtime engine ref.
   */
  runner?:
    | string
    | {
        ref?: string
        file?: string
        inline?: {
          [k: string]: unknown
        }
      }
  /**
   * AIP-14 tool refs.
   */
  tools?: AnyRef[]
  /**
   * Explicit action allow-list. POLICY checks union of this + tools' implements.
   */
  actions?: {
    granted?: ActionRef[]
  }
  /**
   * AIP-3 skill refs.
   */
  skills?: AnyRef[]
  /**
   * AIP-15 workflow refs.
   */
  workflows?: AnyRef[]
  /**
   * AIP-41 routine refs that auto-fire this agent.
   */
  routines?: AnyRef[]
  /**
   * Sub-agents this agent may dispatch to (council pattern, AIP-24).
   */
  delegates_to?: AnyRef[]
  memory?: MemoryConfig
  /**
   * AIP-27 ref primitive — string shorthand or { ref | file | inline }.
   */
  governance?:
    | string
    | {
        ref?: string
        file?: string
        inline?: {
          [k: string]: unknown
        }
      }
  /**
   * AIP-27 ref primitive — string shorthand or { ref | file | inline }.
   */
  policy?:
    | string
    | {
        ref?: string
        file?: string
        inline?: {
          [k: string]: unknown
        }
      }
  /**
   * Free-form numeric trait scores (0-10).
   */
  traits?: {
    [k: string]: number
  }
  /**
   * How much the agent acts vs asks. 0 = always asks, 10 = full autonomy.
   */
  autonomy?: number
  /**
   * Hard rules the agent MUST decline / escalate. Surfaced into system prompt.
   */
  boundaries?: string[]
  /**
   * Lifecycle hooks. AIP-37 event name -> action-ref(s) to invoke.
   */
  on?: {
    [k: string]: ActionRef | ActionRef[]
  }
  publish?: {
    visibility?: "private" | "unlisted" | "public"
    registry?: string
  }
  tags?: string[]
  metadata?: {
    [k: string]: unknown
  }
}
/**
 * Memory configuration.
 */
export interface MemoryConfig {
  scope?: "per-conversation" | "per-thread" | "per-workspace" | "none"
  retention_turns?: number
  semantic?: {
    enabled?: boolean
    embedder?: ModelRef
    top_k?: number
  }
}

export type AgentHandle = Readonly<AgentDefinition>
