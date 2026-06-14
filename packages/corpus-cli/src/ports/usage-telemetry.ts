/**
 * Usage telemetry for the metered distill path — cost visibility + optional
 * Langfuse export. SDK-free (raw fetch to Langfuse's ingestion API), mirroring
 * the distiller's own no-client-lib ethos and keeping corpus-cli lean.
 *
 * Two outputs, both best-effort (telemetry must never break a distill run):
 *   1. a per-run cost summary printed to stderr (always);
 *   2. one Langfuse trace with a GENERATION observation per LLM call, when
 *      LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY (+ LANGFUSE_BASE_URL) are set.
 *
 * Langfuse runs (test/prod/local) share one project, filtered by the
 * `environment` tag (LANGFUSE_TRACING_ENVIRONMENT) — same convention as the
 * Mastra agent tracing in @agstudio/agent-framework.
 */

import { randomUUID } from "node:crypto"

/** One metered LLM call's usage, reported by a distiller. */
export interface DistillUsage {
  /** Model id as returned by the API (falls back to the requested model). */
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  /** Human label for the call — the source title. */
  readonly label: string
  readonly startedAt: string
  readonly endedAt: string
}

/** A sink a distiller calls once per metered LLM call. `flush` ships + reports. */
export interface UsageSink {
  record(usage: DistillUsage): void
  flush(): Promise<void>
}

/** USD per million tokens, matched by model-id substring. Estimate only — */
/** Langfuse prices authoritatively from its own model table when exporting. */
const PRICING: ReadonlyArray<{
  readonly match: string
  readonly inPerM: number
  readonly outPerM: number
}> = [
  { match: "opus", inPerM: 15, outPerM: 75 },
  { match: "haiku", inPerM: 1, outPerM: 5 },
  { match: "sonnet", inPerM: 3, outPerM: 15 },
]

function priceFor(model: string): { inPerM: number; outPerM: number } {
  const m = model.toLowerCase()
  return PRICING.find(p => m.includes(p.match)) ?? { inPerM: 3, outPerM: 15 }
}

function costUsd(u: DistillUsage): { input: number; output: number; total: number } {
  const { inPerM, outPerM } = priceFor(u.model)
  const input = (u.inputTokens / 1_000_000) * inPerM
  const output = (u.outputTokens / 1_000_000) * outPerM
  return { input, output, total: input + output }
}

interface LangfuseConfig {
  readonly baseUrl: string
  readonly publicKey: string
  readonly secretKey: string
  readonly environment: string | undefined
}

function readLangfuseConfig(): LangfuseConfig | undefined {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.LANGFUSE_SECRET_KEY
  if (!publicKey || !secretKey) return undefined
  return {
    baseUrl: (process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com").replace(/\/+$/, ""),
    publicKey,
    secretKey,
    environment: process.env.LANGFUSE_TRACING_ENVIRONMENT,
  }
}

const fmt = (n: number) => n.toLocaleString("en-US")
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`

/**
 * Build a usage sink. Pass a `runName` (e.g. the workspace) for the Langfuse
 * trace name. Langfuse export is enabled automatically when its env keys exist.
 */
export function createUsageSink(opts: { runName: string }): UsageSink {
  const records: DistillUsage[] = []
  const lf = readLangfuseConfig()

  async function shipToLangfuse(cfg: LangfuseConfig, traceId: string): Promise<number> {
    const auth = Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64")
    const now = new Date().toISOString()
    const batch: unknown[] = [
      {
        id: randomUUID(),
        type: "trace-create",
        timestamp: now,
        body: {
          id: traceId,
          name: `corpus-distill: ${opts.runName}`,
          timestamp: now,
          ...(cfg.environment ? { environment: cfg.environment } : {}),
          metadata: { tool: "corpus-cli", phase: "distill", calls: records.length },
        },
      },
      ...records.map(u => {
        const c = costUsd(u)
        return {
          id: randomUUID(),
          type: "generation-create",
          timestamp: u.endedAt,
          body: {
            id: randomUUID(),
            traceId,
            type: "GENERATION",
            name: u.label,
            model: u.model,
            startTime: u.startedAt,
            endTime: u.endedAt,
            ...(cfg.environment ? { environment: cfg.environment } : {}),
            usage: {
              input: u.inputTokens,
              output: u.outputTokens,
              total: u.inputTokens + u.outputTokens,
              unit: "TOKENS",
              inputCost: c.input,
              outputCost: c.output,
              totalCost: c.total,
            },
          },
        }
      }),
    ]
    const res = await fetch(`${cfg.baseUrl}/api/public/ingestion`, {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ batch }),
    })
    if (!res.ok) {
      throw new Error(`${res.status}: ${(await res.text()).slice(0, 160)}`)
    }
    return records.length
  }

  return {
    record(u) {
      records.push(u)
    },
    async flush() {
      if (records.length === 0) return

      // Per-model rollup for the stderr summary.
      const byModel = new Map<
        string,
        { input: number; output: number; cost: number; calls: number }
      >()
      let grandTotal = 0
      for (const u of records) {
        const c = costUsd(u)
        grandTotal += c.total
        const m = byModel.get(u.model) ?? { input: 0, output: 0, cost: 0, calls: 0 }
        m.input += u.inputTokens
        m.output += u.outputTokens
        m.cost += c.total
        m.calls += 1
        byModel.set(u.model, m)
      }

      process.stderr.write(`\nusage — ${records.length} metered call(s):\n`)
      for (const [model, m] of byModel) {
        process.stderr.write(
          `  ${model}  ${m.calls} call(s) · in ${fmt(m.input)} · out ${fmt(m.output)} · ~${usd(m.cost)} est.\n`
        )
      }
      process.stderr.write(`  total ~${usd(grandTotal)} est.\n`)

      if (!lf) {
        process.stderr.write(
          "  langfuse: not configured (set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY to export traces).\n"
        )
        return
      }
      const traceId = randomUUID()
      try {
        const n = await shipToLangfuse(lf, traceId)
        process.stderr.write(
          `  langfuse: shipped ${n} generation(s) → trace ${traceId}` +
            `${lf.environment ? ` (env: ${lf.environment})` : ""}\n`
        )
      } catch (e) {
        process.stderr.write(
          `  langfuse: export failed — ${e instanceof Error ? e.message : String(e)}\n`
        )
      }
    },
  }
}
