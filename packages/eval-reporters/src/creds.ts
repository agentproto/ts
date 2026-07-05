import { makeCredsStore, type CredsStore } from "@agentproto/provider-kit"
import { EVAL_REPORTER_FAMILY } from "./catalog.js"

/** Credentials required by the Langfuse eval reporter backend. */
export interface LangfuseCreds {
  readonly publicKey: string
  readonly secretKey: string
  readonly baseUrl: string
  readonly environment?: string
}

/** Union of all eval-reporter credential shapes (per-slug). */
export type EvalReporterCreds = LangfuseCreds

/**
 * Build the eval-reporter creds store (per-slug, 0600) at
 * `~/.agentproto/eval-reporter-creds/`.
 */
export function makeEvalReporterCredsStore(
  home?: string,
): CredsStore<EvalReporterCreds> {
  return makeCredsStore<EvalReporterCreds>({
    family: EVAL_REPORTER_FAMILY,
    ...(home ? { home } : {}),
  })
}
