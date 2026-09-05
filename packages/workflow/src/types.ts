/**
 * AIP-15 WorkflowDefinition + WorkflowHandle.
 *
 * `WorkflowDefinition` was generated from
 * `resources/aip-15/draft/WORKFLOW.schema.json` via json-schema-to-typescript.
 * `WorkflowHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

export type Step = StepCommon &
  (
    | StepTool
    | StepBranch
    | StepParallel
    | StepSuspend
    | StepApproval
    | StepMap
    | StepLoop
    | StepSubworkflow
    | StepAgent
    | StepGate
  )
export type Approval = ("auto" | "always" | "on-mutate" | "per-step") | string
export type Trigger =
  | {
      kind: "schedule"
      cron: string
      timezone?: string
    }
  | {
      kind: "webhook"
      path: string
    }
  | {
      kind: "event"
      name: string
    }
  | {
      kind: "manual"
      label?: string
    }

/**
 * Validates the YAML frontmatter portion of an AIP-15 WORKFLOW.md manifest.
 */
export interface WorkflowDefinition {
  name: string
  id: string
  description: string
  version: string
  entry?: string
  inputs: Inputs
  outputs: Outputs
  /**
   * Optional value expression mapping step results to the workflow output,
   * using the same reference grammar as a step's `inputs` ($input.*,
   * $steps.<id>.*, literals). Omitted ⇒ the output is the final step's result.
   * Its shape SHOULD satisfy `outputs`.
   */
  result?: Record<string, unknown> | string
  /**
   * @minItems 1
   */
  steps: [Step, ...Step[]]
  start?: string
  suspendable?: boolean
  triggers?: Trigger[]
  requires?: {
    network?: string[]
    "fs.read"?: string[]
    "fs.write"?: string[]
    env?: string[]
    secrets?: string[]
    tools?: string[]
  }
  approval?: ("auto" | "always" | "on-mutate" | "per-step") | string
  risk_level?: number
  timeout_ms?: number
  max_steps?: number
  retry?: Retry
  cost_class?: "trivial" | "metered" | "expensive"
  tags?: string[]
  metadata?: {
    [k: string]: unknown
  }
  inputsFiles?: InputsFiles
  outputsFiles?: OutputsFiles
  runtime?: Runner
}
/**
 * Defined by AIP-16 — the IO `inputs` block.
 */
export interface Inputs {}
/**
 * Defined by AIP-16 — the IO `outputs` block.
 */
export interface Outputs {}
export interface StepCommon {
  id: string
  name?: string
  description?: string
  kind:
    | "tool"
    | "branch"
    | "parallel"
    | "suspend"
    | "approval"
    | "map"
    | "loop"
    | "subworkflow"
    | "agent"
    | "gate"
  inputs?: {}
  outputs?: JsonSchema
  next?: string
  approval?: Approval
  risk_level?: number
  timeout_ms?: number
  retry?: Retry
  compensation?: string
}
/**
 * Any JSON Schema draft 2020-12 document. Validation deferred to a meta-validator.
 */
export interface JsonSchema {}
export interface Retry {
  max_attempts: number
  backoff: "fixed" | "exponential"
  initial_ms?: number
}
export interface StepTool {
  kind: "tool"
  tool:
    | string
    | {
        entry: string
      }
}
export interface StepBranch {
  kind: "branch"
  /**
   * @minItems 1
   */
  branches: [
    {
      when: string
      next: string
    },
    ...{
      when: string
      next: string
    }[]
  ]
  default?: string
}
export interface StepParallel {
  kind: "parallel"
  /**
   * @minItems 2
   */
  branches: [
    {
      id: string
      steps: Step[]
      next?: string
    },
    {
      id: string
      steps: Step[]
      next?: string
    },
    ...{
      id: string
      steps: Step[]
      next?: string
    }[]
  ]
}
export interface StepSuspend {
  kind: "suspend"
  resume: {
    /**
     * @minItems 1
     */
    on: [string, ...string[]]
    timeout_ms?: number
    on_timeout?: string
  }
}
export interface StepApproval {
  kind: "approval"
  prompt: string
  artifacts?: string[]
  /**
   * @minItems 1
   */
  approvers: [
    (
      | {
          role: string
        }
      | {
          userId: string
        }
    ),
    ...(
      | {
          role: string
        }
      | {
          userId: string
        }
    )[]
  ]
  timeout_ms?: number
  on_approve?: {
    next?: string
  }
  on_reject?: {
    next?: string
  }
  on_timeout?: string
}
export interface StepMap {
  kind: "map"
  over: string
  parallelism?: number
  steps: Step[]
  /**
   * Hand-tuned ahead of the generated JSON Schema (not yet in
   * `resources/aip-15/draft/WORKFLOW.schema.json`): `"throw"` (default)
   * aborts the whole map on the first item to fail; `"collect"` runs every
   * item to completion and binds a `TolerantFanOutResult` instead of a bare
   * array — see `@agentproto/workflow-runtime`'s `MapStep.onError`.
   */
  onError?: "throw" | "collect"
}
export interface StepLoop {
  kind: "loop"
  while: string
  max_iterations: number
  steps: Step[]
}
export interface StepSubworkflow {
  kind: "subworkflow"
  workflow: string
}
/**
 * Spawn or reuse an agent session and send it a prompt — the declarative
 * manifest counterpart of `@agentproto/workflow-runtime`'s `AgentStep`
 * (see WP-B4 / `compileWorkflow`). `agent.ref` names an app-scoped agent id
 * (e.g. `"@my-app/reviewer"`) the host resolves to a concrete adapter +
 * spawn options at compile time — an unresolvable ref fails compilation,
 * never the run.
 */
export interface StepAgent {
  kind: "agent"
  /** App-scoped agent id to resolve at compile time. Omit to spawn a plain
   *  `adapter` (no app-ref resolution) or reuse via `sessionRef`. */
  agent?: {
    ref: string
  }
  prompt: string
  /** Adapter slug for spawning a NEW session. Ignored (and unnecessary) when
   *  `agent.ref` resolves one for you. Omit both to reuse via `sessionRef`. */
  adapter?: string
  /** Reuse an earlier agent step's spawned session, by that step's id. */
  sessionRef?: string
  sandbox?: string | { provider: string; [k: string]: unknown }
  /** Cache this step's output under the run's cacheKey. Default false. */
  cacheable?: boolean
  /** Re-prompt-and-retry attempts on `outputSchema` mismatch. Default 2. */
  maxRetries?: number
  /** A zod `ZodType` (TS-authored) validating the session's final message;
   *  re-prompts on mismatch. */
  outputSchema?: unknown
  policy?:
    | { awaiting: "auto-allow"; prompt: string }
    | { awaiting: "escalate"; webhookUrl?: string; timeoutMs?: number }
    | { awaiting: "fail" }
  /** Manifest-declared adapter option id → value, forwarded to a NEW spawn's
   *  `startSession({ options })` — e.g. mastra-agent's `agent` option, set by
   *  `agent.ref` resolution at compile time. Only meaningful with `adapter`;
   *  ignored on a `sessionRef` reuse. May also be authored directly. */
  options?: Record<string, boolean | number | string>
  /** Harness pinning for this step's spawn (AIP-15 P2). Precedence when a
   *  field is also set elsewhere: step `harness` > the resolved AGENT.md's
   *  own frontmatter > `app_run` caller args > the adapter's own default. */
  harness?: Harness
}
/**
 * Harness pinning block on a `kind: "agent"` step. Every field is optional —
 * an unset field falls through to the next layer in the precedence chain
 * documented on {@link StepAgent.harness}.
 */
/**
 * One AIP-10 corpus workspace attachment on a `kind: "agent"` step's
 * `harness.knowledge[]`. Entries matching the selector are materialized
 * into the step's cwd (`.knowledge/`) before the step's session runs —
 * v1 mode is `"files"` only (`"tool"` is reserved for a later revision
 * and rejected by the schema).
 */
export interface KnowledgeSelector {
  /** Path to an AIP-10 corpus workspace root — relative to the WORKFLOW.md's
   *  directory (resolved by the loader to an absolute path) or absolute. */
  workspace: string
  /** Tags with OR semantics — an entry matching ANY of these passes (maps to
   *  `resolveKnowledge`'s `query.tags`). Empty/absent = no tag filter. */
  anyOf?: string[]
  /** Tags that must ALL be present on an entry (post-filter, applied after
   *  `anyOf`). */
  allOf?: string[]
  /** Refined-kind filter (e.g. `"fact"` | `"howto"`) — only entries of these
   *  kinds pass. */
  kinds?: string[]
  /** Cap on materialized entries, applied after sorting by slug ascending
   *  (deterministic). Default 50. */
  maxEntries?: number
  /** Materialization mode. v1 supports only `"files"` (write entries into
   *  the step cwd's `.knowledge/`); other values are rejected by the schema
   *  and the loader. */
  mode?: "files"
  /** Internal — set by `@agentproto/workflow-loader` when a selector string
   *  carries `$…` run-time references. Not user-authored; authoring it is
   *  rejected by the loader. */
  deferred?: boolean
}
/**
 * Harness pinning block on a `kind: "agent"` step. Every field is optional —
 * an unset field falls through to the next layer in the precedence chain
 * documented on {@link StepAgent.harness}.
 */
export interface Harness {
  /** Model id override for this spawn. */
  model?: string
  /** Reasoning-effort override for this spawn (adapter-defined vocabulary,
   *  e.g. `"low"` | `"medium"` | `"high"`). */
  effort?: string
  /** Spawn-time role (see `@agentproto/runtime`'s `resolveRole`) — governs
   *  the child's tool-policy disposition (e.g. `"executor"` | `"supervisor"`). */
  role?: string
  /** Per-spawn tool allowlist. Applied where the resolved adapter supports a
   *  generic per-spawn allowlist mechanism; where it doesn't, the host MUST
   *  record `toolsApplied: false` on the step's run record and emit a
   *  warning event rather than silently ignoring the field. */
  tools?: string[]
  /** Skill ids auto-mounted into the spawn (the same mechanism
   *  `config.json`'s `defaults.skills` / `defaults.adapters.<slug>.skills`
   *  drives) — adapters with no such option (e.g. claude-code, which
   *  auto-discovers skills) ignore it. */
  skills?: string[]
  /** Working directory override for this step's spawn. Takes precedence over
   *  the run-level cwd. */
  cwd?: string
  /** Read this file (relative to the WORKFLOW.md's directory) at load time
   *  and use its contents as the step's `prompt`. Mutually informational
   *  with an inline `prompt` — when both are present, the file wins and the
   *  inline `prompt` is replaced. */
  promptFile?: string
  /** Computed by the loader at load time — sha256 (hex) of `promptFile`'s
   *  raw bytes. Not hand-authored; present only when `promptFile` was
   *  resolved. Exposed on the compiled step and in run records so a
   *  consumer can verify which exact prompt version a run used. */
  promptSha?: string
  /** AIP-10 corpus knowledge to materialize into this step's cwd (under
   *  `.knowledge/`) before the session runs. See {@link KnowledgeSelector}. */
  knowledge?: KnowledgeSelector[]
}
/**
 * `kind: "gate"` — run a shell command through the host's subprocess runner
 * (AIP-17) as a deterministic pass/fail check. Exit code 0 is a pass; any
 * other exit code is a failure, subject to `StepCommon.retry`. The process'
 * stdout, if it parses as JSON, becomes the gate's report; otherwise, when
 * `report` names a file, that file is read (relative to `cwd`) and parsed as
 * JSON instead. The report — plus `ok` and `exitCode` — is bound at
 * `$steps.<id>.report` / `.ok` / `.exitCode` for later steps to read, and
 * emitted as a `gate-report` lifecycle event on the run's event stream.
 */
export interface StepGate {
  kind: "gate"
  /** The command to execute. No shell interpolation — invoked as an argv
   *  vector (`command` + `args`), never through a shell. */
  command: string
  args?: string[]
  /** Working directory. Defaults to the workflow run's own cwd. */
  cwd?: string
  /** Path (relative to `cwd`) of a JSON report file, consulted when stdout
   *  doesn't itself parse as JSON. */
  report?: string
  /** Re-prompt-and-rerun on a failing exit code, bounded by
   *  `StepCommon.retry.max_attempts`. Runs BEFORE each retry attempt after
   *  the first: sends the named prior agent step's session (reused via that
   *  step's `sessionRef`, same as a `kind: "agent"` step reuse) a prompt with
   *  this gate's last report injected, waits for its turn, then re-runs the
   *  gate command. */
  on_fail?: {
    /** The prior `kind: "agent"` step id to re-prompt. */
    reprompt: string
    /** Extra literal context merged into the reprompt, alongside the gate's
     *  `$steps.<id>.report`. */
    with?: Record<string, unknown>
  }
}
/**
 * Defined by AIP-16 — the IO `inputsFiles` block.
 */
export interface InputsFiles {
  [k: string]: FileContractEntry
}
/**
 * A single declared file in inputsFiles/outputsFiles.
 */
export interface FileContractEntry {
  /**
   * Workspace-relative path. outputsFiles entries MAY use the tokens <runId>, <workflowId>, <toolId>, <isoDate> for per-run path interpolation.
   */
  path: string
  /**
   * Convention only — not enforced by the contract. `ro` for inputs is the typical default; `rw` for outputs.
   */
  mode?: "ro" | "rw"
  /**
   * Informational MIME type. Hosts MAY surface in audit logs / UIs.
   */
  contentType?: string
}
/**
 * Defined by AIP-16 — the IO `outputsFiles` block.
 */
export interface OutputsFiles {
  [k: string]: FileContractEntry
}
/**
 * Defined by AIP-17 — the runner block.
 */
export interface Runner {
  /**
   * Where the process runs. `subprocess` (default): host-local Node `--permission` child. `sandbox`: real container via the host's SandboxProviderAdapter. `in-process`: dynamic import inside the host process; reserved for trusted/vendor code, silently downgraded to `subprocess` for untrusted origins.
   */
  engine?: "subprocess" | "sandbox" | "in-process"
  /**
   * Sandbox template id from the host registry. Only meaningful for `engine: sandbox`. When omitted, the host auto-picks via `needs`.
   */
  image?: string
  /**
   * Declarative dependency requirements. Hosts use these to auto-pick an image, install missing deps at cold-start, and surface them in trust UIs.
   */
  needs?: {
    /**
     * Primary language runtime.
     */
    language?: "node" | "python" | "multi"
    /**
     * OS-level package names. Default convention: Debian/Ubuntu apt names.
     */
    native?: string[]
    /**
     * Additional npm packages installed via `npm install` after lockfile-driven `npm ci`.
     */
    npm?: string[]
    /**
     * Additional pip packages installed via `pip install --user`.
     */
    pip?: string[]
  }
  /**
   * Resource caps. Advisory but enforceable when the isolation primitive supports it.
   */
  limits?: {
    /**
     * Hard memory cap in MiB.
     */
    memory_mb?: number
    /**
     * Hard wall-clock cap in ms.
     */
    timeout_ms?: number
    /**
     * CPU-time cap in ms. Hosts that can't enforce it ignore this field.
     */
    cpu_ms?: number
  }
}

export type WorkflowHandle = Readonly<WorkflowDefinition>
