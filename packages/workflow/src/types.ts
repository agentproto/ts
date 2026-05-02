/**
 * AIP-15 WorkflowDefinition + WorkflowHandle.
 *
 * `WorkflowDefinition` was generated from
 * `resources/aip-15/draft/WORKFLOW.schema.json` via json-schema-to-typescript.
 * `WorkflowHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

export type Step = StepCommon &
  (StepTool | StepBranch | StepParallel | StepSuspend | StepApproval | StepMap | StepLoop | StepSubworkflow)
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
  kind: "tool" | "branch" | "parallel" | "suspend" | "approval" | "map" | "loop" | "subworkflow"
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
