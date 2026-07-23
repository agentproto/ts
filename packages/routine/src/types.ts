/**
 * AIP-41 RoutineDefinition + RoutineHandle.
 *
 * `RoutineDefinition` was generated from
 * `resources/aip-41/draft/ROUTINE.schema.json` via json-schema-to-typescript.
 * `RoutineHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

export type IdentityRef =
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
 * Validates the YAML frontmatter portion of an AIP-41 ROUTINE.md manifest. Decouples 'when' (schedule) from 'what' (target action/workflow/tool).
 */
export interface RoutineDefinition {
  schema: "routine/v1"
  /**
   * Machine identifier. Lowercase, digits, dashes, dots, optional @owner/ prefix. Unique within the registry that hosts the routine.
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
   * When the routine fires.
   */
  schedule: ScheduleCron | ScheduleInterval | ScheduleCalendar | ScheduleManual | ScheduleEvent
  /**
   * What the routine invokes when it fires.
   */
  target: TargetAction | TargetAgent | TargetWorkflow | TargetTool
  /**
   * Identity that owns the routine fire (AIP-23). Defaults to host policy.
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
  retry?: Retry
  on_failure?: OnFailure
  history?: History
  /**
   * AIP-37 LIFECYCLE event names this routine fires.
   */
  fires_events?: string[]
  /**
   * If false, routine registers but does not fire. Useful for staging.
   */
  enabled?: boolean
  /**
   * Free-form discovery tags.
   */
  tags?: string[]
  /**
   * Free-form, namespaced.
   */
  metadata?: {
    [k: string]: unknown
  }
}
export interface ScheduleCron {
  kind: "cron"
  /**
   * Standard 5-field cron expression.
   */
  cron: string
  /**
   * IANA tz database name. Legacy abbreviations rejected.
   */
  timezone?: string
  jitter_seconds?: number
  catchup?: "skip" | "one" | "all"
}
export interface ScheduleInterval {
  kind: "interval"
  /**
   * Duration: Ns | Nm | Nh | Nd.
   */
  every: string
  /**
   * OPTIONAL anchor; default = registration time.
   */
  from?: string
  jitter_seconds?: number
}
export interface ScheduleCalendar {
  kind: "calendar"
  /**
   * RFC 5545 RRULE.
   */
  rrule: string
  timezone?: string
}
export interface ScheduleManual {
  kind: "manual"
}
export interface ScheduleEvent {
  kind: "event"
  /**
   * AIP-37 LIFECYCLE event name.
   */
  on: string
  /**
   * OPTIONAL — only fire if event payload matches filter.
   */
  filter?: {
    [k: string]: unknown
  }
}
export interface TargetAction {
  /**
   * AIP-39 ACTION ref. Resolver picks tool implementation.
   */
  action: string
  /**
   * Invocation payload. May reference ${{ vault.* }} and ${{ now }}.
   */
  inputs?: {
    [k: string]: unknown
  }
}
/**
 * Ergonomic sugar target — spawns an agent session directly (lowers to an
 * `agent_start` tool call in the runtime bridge). NOT part of the upstream
 * AIP-41 draft JSON Schema yet — see packages/routine/README.md "Runtime
 * bridge" section for the specs-repo follow-up this implies.
 */
export interface TargetAgent {
  agent: {
    /** Agent adapter slug (e.g. 'claude-code', 'hermes'). */
    adapter: string
    /** Initial prompt / consigne sent to the spawned agent. */
    prompt: string
    model?: string
    cwd?: string
  }
}
export interface TargetWorkflow {
  /**
   * AIP-15 WORKFLOW ref.
   */
  workflow: string | AnyRef
  inputs?: {
    [k: string]: unknown
  }
}
/**
 * AIP-27 ref primitive — exactly one of ref|file|inline.
 */
export interface AnyRef {
  ref?: string
  file?: string
  inline?: {
    [k: string]: unknown
  }
}
export interface TargetTool {
  /**
   * AIP-14 TOOL id (pin specific implementation).
   */
  tool: string
  inputs?: {
    [k: string]: unknown
  }
}
/**
 * Retry behaviour on failure.
 */
export interface Retry {
  max_attempts?: number
  backoff?: "exponential" | "linear" | "fixed"
  initial_ms?: number
  max_ms?: number
  /**
   * OPTIONAL — only retry these failure classes.
   */
  on?: string[]
}
/**
 * Where to route failures after retries exhaust.
 */
export interface OnFailure {
  /**
   * Identity-refs to notify.
   */
  notify?: IdentityRef[]
  /**
   * Open AIP-13/20 WORK item on retry-exhausted failure.
   */
  create_work_item?: boolean
  /**
   * OPTIONAL custom AIP-37 event to fire on failure.
   */
  fire_event?: string
}
/**
 * Run history retention.
 */
export interface History {
  retain_runs?: number
  retain_failed?: number
}

export type RoutineHandle = Readonly<RoutineDefinition>
