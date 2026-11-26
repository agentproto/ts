import { z } from "zod"

/**
 * Period granularity carried by a {@link MetricSample}.
 * Note: `"total"` is derived/cumulative and is not requested directly as a
 * collection window (see {@link WindowKind}).
 */
export const PeriodKind = z.enum(["point", "day", "week", "month", "total"])
export type PeriodKind = z.infer<typeof PeriodKind>

/**
 * Requestable collection window kinds accepted by a collection engine.
 * `"total"` is intentionally excluded because cumulative totals are derived
 * from stored observations rather than fetched as a closed time window.
 */
export const WindowKind = z.enum(["point", "day", "week", "month"])
export type WindowKind = z.infer<typeof WindowKind>

export const Unit = z.enum([
  "eur",
  "usd",
  "count",
  "percent",
  "credits",
  "ms",
  "boolean",
])
export type Unit = z.infer<typeof Unit>

export const PaginationSpec = z.object({
  kind: z.enum(["none", "cursor", "page"]),
  cursorField: z.string().optional(),
  hasMoreField: z.string().optional(),
  itemsPath: z.string().optional(),
})
export type PaginationSpec = z.infer<typeof PaginationSpec>

export const MetricDescriptor = z.object({
  id: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/),
  label: z.string().min(1),
  unit: Unit,
  scale: z.number().default(1),
  currency: z.string().length(3).optional(),
  supportedPeriods: z.array(PeriodKind).nonempty(),
  aggregation: z.enum(["sum", "count", "last", "max", "min", "avg"]),
  valueField: z.string().optional(),
  pagination: PaginationSpec.default({ kind: "none" }),
})
export type MetricDescriptor = z.infer<typeof MetricDescriptor>
export type MetricDescriptorInput = z.input<typeof MetricDescriptor>

export const MetricSample = z.object({
  metric: z.string().min(1),
  value: z.number().finite(),
  unit: Unit,
  periodKind: PeriodKind,
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  observedAt: z.string().datetime(),
  source: z.string().min(1),
  idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/),
  runId: z.string().optional(),
  proof: z.string().optional(),
})
export type MetricSample = z.infer<typeof MetricSample>

export const MetricTarget = z.object({
  metricId: z.string().min(1),
  direction: z.enum(["gte", "lte"]),
  target: z.number().finite(),
  unit: Unit,
  weight: z.number().default(1),
})
export type MetricTarget = z.infer<typeof MetricTarget>

export const HttpAuthSpec = z.object({
  secretRef: z.string().min(1),
  headerName: z.string().min(1).default("Authorization"),
  prefix: z.string().default("Bearer "),
})
export type HttpAuthSpec = z.infer<typeof HttpAuthSpec>

export const HttpRequestSpec = z.object({
  endpoint: z.string().min(1),
  queryTemplate: z.record(z.string(), z.string()).optional(),
  responseExtract: z.string().optional(),
})
export type HttpRequestSpec = z.infer<typeof HttpRequestSpec>

export const HttpTransportSpec = z
  .object({
    kind: z.literal("http"),
    baseUrl: z.string().url(),
    readOnly: z.literal(true),
    auth: HttpAuthSpec,
    defaultHeaders: z.record(z.string(), z.string()).optional(),
    request: HttpRequestSpec,
  })
  .superRefine((val, ctx) => {
    if (!val.defaultHeaders) return
    const authHeaderLower = val.auth.headerName.toLowerCase()
    for (const key of Object.keys(val.defaultHeaders)) {
      if (key.toLowerCase() === authHeaderLower) {
        ctx.addIssue({
          code: "custom",
          path: ["defaultHeaders", key],
          message:
            `defaultHeaders must not duplicate auth.headerName '${val.auth.headerName}'; ` +
            "the collector composes the authentication header from transport.auth.",
        })
      }
    }
  })
export type HttpTransportSpec = z.infer<typeof HttpTransportSpec>

export const McpImportedTransportSpec = z.object({
  kind: z.literal("mcp-imported"),
  alias: z.string().min(1),
  tool: z.string().min(1),
  readOnly: z.literal(true).default(true),
})
export type McpImportedTransportSpec = z.infer<typeof McpImportedTransportSpec>

export const SqlRoTransportSpec = z.object({
  kind: z.literal("sql-ro"),
  connectionRef: z.string().min(1),
  query: z.string().min(1),
  readOnly: z.literal(true).default(true),
})
export type SqlRoTransportSpec = z.infer<typeof SqlRoTransportSpec>

export const MetricTransportSpec = z.discriminatedUnion("kind", [
  HttpTransportSpec,
  McpImportedTransportSpec,
  SqlRoTransportSpec,
])
export type MetricTransportSpec = z.infer<typeof MetricTransportSpec>

export const MetricSourceSchedule = z.object({
  kind: z.literal("cron"),
  cron: z.string().min(1),
  timezone: z.string().min(1).optional(),
  windowKind: WindowKind.default("day"),
  windowAnchor: z.string().min(1).default("previous-closed-day"),
  targetTool: z.string().min(1).default("metrics_collect"),
  metricIds: z.array(z.string().min(1)).optional(),
})
export type MetricSourceSchedule = z.infer<typeof MetricSourceSchedule>

export const MetricSourceDestination = z.object({
  collection: z.literal("metric-sample"),
  emitTo: z.string().min(1),
})
export type MetricSourceDestination = z.infer<typeof MetricSourceDestination>

export const MetricSourceSpec = z.object({
  schema: z.literal("metric-source/v1"),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  toolId: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/).optional(),
  routineId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/).optional(),
  description: z.string().min(1),
  transport: MetricTransportSpec,
  inputs: z.record(z.string(), z.unknown()),
  rawOutput: z.record(z.string(), z.unknown()),
  metrics: z.array(MetricDescriptor).nonempty(),
  schedule: MetricSourceSchedule,
  destination: MetricSourceDestination,
})

export type MetricSourceSpec = z.infer<typeof MetricSourceSpec>
export type MetricSourceSpecInput = z.input<typeof MetricSourceSpec>
export type MetricSourceHandle = Readonly<MetricSourceSpec>

/**
 * Validate and freeze a declarative metric source specification.
 */
export function defineMetricSource(input: MetricSourceSpecInput): MetricSourceHandle {
  const parsed = MetricSourceSpec.parse(input)
  return Object.freeze(parsed)
}
