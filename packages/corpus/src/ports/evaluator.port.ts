/**
 * EvaluatorPort — minimal evaluator contract the corpus kit consumes.
 *
 * The kit never imports IEvaluator from @agstudio/integration-evaluator
 * (that's an agstudio type, would break the purity invariant). Instead
 * it consumes this minimal port; the agstudio side's
 * `RubricStringEvaluatorAdapter` / `LLMJudgeEvaluatorAdapter` /
 * `EnsembleEvaluatorAdapter` all satisfy it structurally.
 *
 * Matches @agstudio/integration-evaluator IEvaluator shape so cloud
 * adapters drop in as `EvaluatorPort` instances without conversion.
 */

export interface EvalRubricPort {
  readonly slug: string
  readonly title: string
  readonly version: string
  readonly dimensions: readonly {
    readonly id: string
    readonly weight: number
    readonly description: string
  }[]
  readonly scoringScale: "0..1" | "0..5"
  readonly passingThreshold: number
  readonly guidance?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface EvalContextPort {
  readonly operatorRef?: string
  readonly conversationId?: string
  readonly appliedPlaybooks?: readonly string[]
  readonly arm?: "shadow" | "baseline" | string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface EvalInputPort {
  readonly rubric: EvalRubricPort
  readonly prompt: string
  readonly response: string
  readonly context?: EvalContextPort
}

export interface EvalResultPort {
  readonly score: number
  readonly dimensions: Readonly<Record<string, number>>
  readonly rationale?: string
  readonly evaluatorEngineId: string
  readonly evaluatorVersion: string
  readonly evaluatedAt: string
}

export interface EvaluatorPort {
  evaluate(input: EvalInputPort): Promise<EvalResultPort>
}
