import { z } from "zod"

/** Full timestamp with offset, e.g. 2026-11-28T10:00:00Z or 2026-11-28T10:00:00+01:00. */
const timestamp = z.iso.datetime({ offset: true })
/** Editorial or platform date: a calendar day or a full timestamp. */
const dateOrTimestamp = z.union([z.iso.date(), z.iso.datetime({ offset: true })])

export const ItemKind = z.enum(["article", "post", "thread", "submission", "review", "video", "query"])
export type ItemKind = z.infer<typeof ItemKind>

export const MissingReason = z.enum(["not_exposed", "hidden", "blocked"])
export type MissingReason = z.infer<typeof MissingReason>

export const MetricName = z.enum([
  "views",
  "likes",
  "reposts",
  "replies",
  "bookmarks",
  "points",
  "comments",
  "reactions",
  "score",
  "rating",
  "helpfulVotes",
])
export type MetricName = z.infer<typeof MetricName>

export const Subject = z.object({
  label: z.string().min(1),
  provenance: z.enum(["query", "source_tag", "classifier"]),
  classifier: z.object({ name: z.string().min(1), version: z.string().min(1) }).optional(),
})
export type Subject = z.infer<typeof Subject>

export const ItemLinks = z.object({
  target: z.string().optional(),
  parent: z.string().optional(),
  root: z.string().optional(),
  quoted: z.string().optional(),
})
export type ItemLinks = z.infer<typeof ItemLinks>

export const ItemPart = z.object({
  id: z.string().min(1),
  text: z.string(),
  authorRef: z.string().optional(),
  // A bare day is accepted: some platforms only display the date of a post.
  postedAt: dateOrTimestamp.optional(),
})
export type ItemPart = z.infer<typeof ItemPart>

export const CollectItem = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceInstance: z.string().optional(),
  kind: ItemKind,
  url: z.string().optional(),
  canonicalUrl: z.string().optional(),
  contentId: z.string().optional(),
  contentGroupId: z.string().optional(),
  subjects: z.array(Subject).default([]),
  title: z.string().optional(),
  text: z.string().optional(),
  textTruncated: z.boolean().optional(),
  language: z.string().optional(),
  wordCount: z.number().int().nonnegative().optional(),
  format: z.string().optional(),
  authorRef: z.string().optional(),
  submitterRef: z.string().optional(),
  publishedAt: dateOrTimestamp.optional(),
  // A bare day is accepted: some platforms only display the date of a post.
  postedAt: dateOrTimestamp.optional(),
  firstSeenAt: timestamp,
  links: ItemLinks.optional(),
  outboundLinks: z.array(z.string()).optional(),
  parts: z.array(ItemPart).optional(),
  tags: z.array(z.string()).optional(),
  hasMedia: z.boolean().optional(),
  query: z.string().optional(),
  runId: z.string().optional(),
  rawRefs: z.array(z.string()).optional(),
  ext: z.record(z.string(), z.unknown()).optional(),
})
export type CollectItem = z.infer<typeof CollectItem>

/** A counter is a number or absent. Absent is never read as zero: see `missing`. */
const metricValues = z.partialRecord(MetricName, z.number())

export const ObservationBase = z.object({
  itemId: z.string().min(1),
  measuredAt: timestamp,
  metrics: metricValues.default({}),
  partMetrics: z.record(z.string(), metricValues).optional(),
  rawValues: z.partialRecord(MetricName, z.string()).optional(),
  missing: z.partialRecord(MetricName, MissingReason).optional(),
  transport: z.string().optional(),
  runId: z.string().optional(),
  rawRef: z.string().optional(),
})

/** Unrefined shape of `Observation`, for consumers that need `.extend()`, `.pick()` or `.partial()`. */
export const Observation = ObservationBase.superRefine((o, ctx) => {
  for (const key of Object.keys(o.missing ?? {})) {
    if (key in o.metrics) {
      ctx.addIssue({
        code: "custom",
        path: ["missing", key],
        message: `${key} is both a metric and missing`,
      })
    }
  }
  // A displayed value always belongs to a parsed number.
  for (const key of Object.keys(o.rawValues ?? {})) {
    if (!(key in o.metrics)) {
      ctx.addIssue({
        code: "custom",
        path: ["rawValues", key],
        message: `${key} has a raw value but no metric`,
      })
    }
  }
})
export type Observation = z.infer<typeof Observation>

export const AudienceKind = z.enum(["followers", "karma", "subscribers"])
export type AudienceKind = z.infer<typeof AudienceKind>

export const AudienceUnknownReason = z.enum(["not_exposed", "not_fetched", "blocked"])
export type AudienceUnknownReason = z.infer<typeof AudienceUnknownReason>

/** One reading of an audience figure. Either `value` is known or `unknown` says why not. */
export const AudienceReading = z
  .object({
    measuredAt: timestamp,
    kind: AudienceKind,
    value: z.number().nonnegative().optional(),
    rawValue: z.string().optional(),
    unknown: AudienceUnknownReason.optional(),
  })
  .refine((r) => (r.value === undefined) !== (r.unknown === undefined), {
    message: "an audience reading has either a value or an unknown reason",
  })
export type AudienceReading = z.infer<typeof AudienceReading>

export const Actor = z.object({
  ref: z.string().min(1),
  displayName: z.string().optional(),
  handle: z.string().optional(),
  profileUrl: z.string().optional(),
  accountCreatedAt: dateOrTimestamp.optional(),
  verified: z.boolean().optional(),
  audience: z.array(AudienceReading).default([]),
})
export type Actor = z.infer<typeof Actor>

export const PickupKind = z.enum(["media_pickup", "crosspost", "media_publication"])
export type PickupKind = z.infer<typeof PickupKind>
export const PickupMethod = z.enum(["link", "content_id", "near_text", "declared", "legacy_flag"])
export type PickupMethod = z.infer<typeof PickupMethod>

/** Methods whose evidence is exact, so the pickup counts as verified. */
export const VERIFIED_PICKUP_METHODS: readonly PickupMethod[] = ["link", "content_id", "declared"]

export const PickupBase = z.object({
  itemId: z.string().min(1),
  kind: PickupKind,
  pickupItemId: z.string().optional(),
  pickupUrl: z.string().optional(),
  outlet: z.string().optional(),
  relation: z.enum(["republication", "citation"]),
  evidence: z.object({
    outboundLink: z.string().optional(),
    excerpt: z.string().optional(),
    similarity: z.number().min(0).max(1).optional(),
    rawRef: z.string().optional(),
  }),
  method: PickupMethod,
  verified: z.boolean(),
  firstSeenAt: timestamp,
  measuredAt: timestamp,
  runId: z.string().optional(),
})

/** Unrefined shape of `Pickup`, for consumers that need `.extend()`, `.pick()` or `.partial()`. */
export const Pickup = PickupBase.superRefine((p, ctx) => {
  if (p.verified !== VERIFIED_PICKUP_METHODS.includes(p.method)) {
    ctx.addIssue({
      code: "custom",
      path: ["verified"],
      message: "verified must be true exactly for link, content_id and declared methods",
    })
    return
  }
  const e = p.evidence
  const hasEvidence = e.outboundLink !== undefined || e.excerpt !== undefined || e.similarity !== undefined
  if (p.method === "link" || p.method === "content_id") {
    if (!hasEvidence) {
      ctx.addIssue({ code: "custom", path: ["evidence"], message: `${p.method} pickup needs evidence` })
    }
    if (!e.rawRef) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence", "rawRef"],
        message: `${p.method} pickup needs evidence.rawRef`,
      })
    }
  } else if (p.method === "declared") {
    if (e.outboundLink === undefined && e.excerpt === undefined && !p.outlet) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "declared pickup needs an excerpt, an outbound link or an outlet",
      })
    }
  }
})
export type Pickup = z.infer<typeof Pickup>

export const Recipe = z.object({
  name: z.string().optional(),
  sources: z
    .array(
      z.object({
        connector: z.string().min(1),
        instance: z.string().optional(),
        queries: z
          .array(
            z.object({
              text: z.string().min(1),
              subject: z.string().min(1),
            }),
          )
          .default([]),
        options: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1),
  window: z.object({ from: timestamp.optional(), to: timestamp.optional() }).optional(),
  sampling: z
    .object({
      bands: z
        .array(
          z.object({
            metric: MetricName,
            min: z.number().optional(),
            max: z.number().optional(),
          }),
        )
        .optional(),
      perDomainCap: z.number().int().positive().optional(),
      seed: z.number().int().optional(),
    })
    .optional(),
  caps: z
    .object({
      perConnector: z.number().int().positive().optional(),
      total: z.number().int().positive().optional(),
    })
    .optional(),
  workers: z.number().int().positive().default(8),
  sinks: z.array(z.string()).optional(),
})
export type Recipe = z.infer<typeof Recipe>

export const FailureCause = z.enum(["blocked", "empty", "network", "parse", "other"])
export type FailureCause = z.infer<typeof FailureCause>

/** Every `with*` field and `eligible` is a count of items; shares are computed by the reader. */
export const CoverageCell = z.object({
  platform: z.string(),
  format: z.string(),
  language: z.string(),
  subject: z.string(),
  items: z.number().int().nonnegative(),
  /** At least one `followers` or `subscribers` reading. Karma is not counted here. */
  withAuthorAudience: z.number().int().nonnegative(),
  withPrimaryMetric: z.number().int().nonnegative(),
  /** `postedAt` and `measuredAt` both present. */
  withAge: z.number().int().nonnegative(),
  withAuthorId: z.number().int().nonnegative(),
  /** `contentId` shared with no other item. */
  withUniqueContent: z.number().int().nonnegative(),
  /** Audience, primary metric, age and author id all present. */
  eligible: z.number().int().nonnegative(),
})
export type CoverageCell = z.infer<typeof CoverageCell>

export const Coverage = z.object({ cells: z.array(CoverageCell) })
export type Coverage = z.infer<typeof Coverage>

export const ConnectorReport = z.object({
  connector: z.string().min(1),
  status: z.enum(["ok", "partial", "failed", "skipped"]).default("ok"),
  skippedReason: z.string().optional(),
  tasks: z.object({
    planned: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  newItems: z.number().int().nonnegative(),
  observations: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  failures: z.partialRecord(FailureCause, z.number().int().nonnegative()).default({}),
  escalations: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        count: z.number().int().positive(),
      }),
    )
    .default([]),
  durationMs: z.number().nonnegative(),
  coverage: Coverage.optional(),
})
export type ConnectorReport = z.infer<typeof ConnectorReport>

export const RunReport = z.object({
  runId: z.string().min(1),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  connectors: z.array(ConnectorReport),
  coverage: Coverage.optional(),
})
export type RunReport = z.infer<typeof RunReport>
