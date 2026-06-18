/**
 * ReportModelPort — the minimal model seam the report's model steps consume.
 *
 * Structural, not nominal: the AIP `ModelPort` (`complete({system?, prompt}) →
 * {result}`) satisfies it as-is, so the same engine runs under any registered
 * model. The single-pass functions here ARE the "model driver" tier; the
 * higher-fidelity claude-code path (Phase C) reuses the same prompt-builders
 * but swaps the executor for file-reading sub-agents.
 */

export interface ReportModelInput {
  readonly system?: string
  readonly prompt: string
}

export interface ReportModelOutput {
  /** Completion payload — string for text, or a structured object. */
  readonly result: string | unknown
}

export interface ReportModelPort {
  complete(input: ReportModelInput): Promise<ReportModelOutput>
}

/** Run a prompt and coerce the completion to text. */
export async function runModel(
  model: ReportModelPort,
  input: ReportModelInput
): Promise<string> {
  const { result } = await model.complete(input)
  return typeof result === "string" ? result : JSON.stringify(result)
}
