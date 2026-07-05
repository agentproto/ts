import { stderrTelemetry, arrayTelemetry, type Telemetry } from "@agentproto/telemetry"
import { langfuseTelemetry } from "@agentproto/telemetry-langfuse"
import type { EvalEvent } from "@agentproto/eval"
import {
  makeAdapterResolver,
  type AdapterHandle,
  type AdapterResolver,
  type CredsStore,
} from "@agentproto/provider-kit"
import { EVAL_REPORTER_CATALOG } from "./catalog.js"
import type { EvalReporterCreds, LangfuseCreds } from "./creds.js"

/**
 * Safe descriptor returned by {@link EvalReporterHandle.info}. NEVER carries
 * a secret value — only capability metadata.
 */
export interface EvalReporterInfo {
  readonly slug: string
  readonly capabilities: {
    readonly needsCreds: boolean
  }
}

/** Resolved eval reporter backend. */
export interface EvalReporterHandle extends AdapterHandle {
  /** Safe descriptor — NEVER a secret. */
  info(): EvalReporterInfo
  /** Build the live sink. langfuse requires creds; stderr/array need none. */
  sink(): Telemetry<EvalEvent> & { flush?(): Promise<unknown> }
}

export interface ResolveEvalReporterOptions {
  /** Stored creds for the slug, or null when none have been configured. */
  readonly creds: EvalReporterCreds | null
}

/**
 * Resolve a catalog slug to a concrete eval reporter handle.
 *
 * Throws for unknown slugs so the kit's resolver wraps the miss to `null`.
 * Known slugs always resolve to a descriptor handle; `sink()` throws when
 * creds are required but missing.
 */
export function resolveEvalReporter(
  slug: string,
  options: ResolveEvalReporterOptions,
): EvalReporterHandle {
  const catalogEntry = EVAL_REPORTER_CATALOG.find((entry) => entry.slug === slug)
  if (catalogEntry === undefined) {
    throw new Error(`unknown eval reporter slug: ${slug}`)
  }

  switch (slug) {
    case "langfuse": {
      const creds = options.creds
      return {
        slug,
        name: catalogEntry.name,
        description: catalogEntry.description,
        version: "0.1.0",
        requiresSetup: true,
        check: async () => true,
        info() {
          return { slug, capabilities: { needsCreds: true } }
        },
        sink() {
          if (creds === null) {
            throw new Error(
              `eval reporter '${slug}' is not configured; run setup_eval_reporter first`,
            )
          }
          const langfuseCreds: LangfuseCreds = creds
          return langfuseTelemetry({
            publicKey: langfuseCreds.publicKey,
            secretKey: langfuseCreds.secretKey,
            baseUrl: langfuseCreds.baseUrl,
            environment: langfuseCreds.environment,
          })
        },
      }
    }
    case "stderr": {
      return {
        slug,
        name: catalogEntry.name,
        description: catalogEntry.description,
        version: "0.1.0",
        requiresSetup: false,
        check: async () => true,
        info() {
          return { slug, capabilities: { needsCreds: false } }
        },
        sink() {
          return stderrTelemetry<EvalEvent>({
            prefix: "eval: ",
            format: formatEvalEvent,
          })
        },
      }
    }
    case "array": {
      return {
        slug,
        name: catalogEntry.name,
        description: catalogEntry.description,
        version: "0.1.0",
        requiresSetup: false,
        check: async () => true,
        info() {
          return { slug, capabilities: { needsCreds: false } }
        },
        sink() {
          return arrayTelemetry<EvalEvent>()
        },
      }
    }
  }

  throw new Error(`unhandled eval reporter slug: ${slug}`)
}

function formatEvalEvent(event: EvalEvent): string {
  switch (event.kind) {
    case "eval.started":
      return `${event.runId} started suite=${event.suiteId} cases=${event.caseCount} scorers=${event.scorerCount}`
    case "eval.case.started":
      return `${event.runId} case.started case=${event.caseId}`
    case "eval.case.scored":
      return `${event.runId} case.scored case=${event.caseId} scorer=${event.scorerId} value=${event.value} passed=${event.passed}`
    case "eval.case.finished":
      return `${event.runId} case.finished case=${event.caseId} passed=${event.passed}`
    case "eval.finished":
      return `${event.runId} finished suite=${event.suiteId} total=${event.total} passed=${event.passedCount} mean=${event.meanValue}ms=${event.durationMs}`
    default: {
      const _exhaustive: never = event
      return JSON.stringify(_exhaustive)
    }
  }
}

/**
 * Build the eval-reporter resolver: reads stored creds and resolves a handle,
 * returning `null` when the slug is unknown (via the kit's wrapper).
 */
export function makeEvalReporterResolver(
  credsStore: CredsStore<EvalReporterCreds>,
): AdapterResolver<EvalReporterHandle> {
  return makeAdapterResolver<EvalReporterHandle>({
    load: async (slug: string): Promise<EvalReporterHandle> => {
      const creds = await credsStore.read(slug)
      return resolveEvalReporter(slug, { creds })
    },
  })
}
