import { createHash } from "node:crypto"
import { z, type ZodType } from "zod"
import type { PeriodKind, WindowKind } from "./schema.js"

export interface IdempotencyKeyParts {
  source: string
  metric: string
  periodKind: PeriodKind
  periodStart: string
  periodEnd: string
}

/**
 * Deterministic SHA-256 hex idempotency key over the canonical closed window.
 * Output is 64 lowercase hex chars, valid for AIP-18 `identity.slugSource`.
 */
export function computeIdempotencyKey(parts: IdempotencyKeyParts): string {
  const canonical = [
    parts.source,
    parts.metric,
    parts.periodKind,
    parts.periodStart,
    parts.periodEnd,
  ].join("|")
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

export interface ResolvedUtcWindow {
  periodKind: WindowKind
  periodStart: string
  periodEnd: string
  periodStartUnix: number
  periodEndUnix: number
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0))
}

function startOfUtcHour(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0),
  )
}

function startOfUtcWeekMonday(d: Date): Date {
  const dayStart = startOfUtcDay(d)
  const dow = dayStart.getUTCDay()
  const diffToMonday = dow === 0 ? 6 : dow - 1
  return new Date(dayStart.getTime() - diffToMonday * 86_400_000)
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0))
}

/**
 * Resolve a closed UTC window `[periodStart, periodEnd)` from `(windowKind, windowAnchor)`.
 * Never uses unquantized wall-clock time so retries produce the exact same bounds and key.
 */
export function resolveClosedUtcWindow(
  windowKind: WindowKind,
  windowAnchor: string,
  now: Date = new Date(),
): ResolvedUtcWindow {
  let start: Date
  let end: Date

  if (windowAnchor === "previous-closed-day") {
    end = startOfUtcDay(now)
    start = new Date(end.getTime() - 86_400_000)
  } else if (windowAnchor === "previous-closed-hour") {
    end = startOfUtcHour(now)
    start = new Date(end.getTime() - 3_600_000)
  } else if (windowAnchor === "previous-closed-week") {
    end = startOfUtcWeekMonday(now)
    start = new Date(end.getTime() - 7 * 86_400_000)
  } else if (windowAnchor === "previous-closed-month") {
    end = startOfUtcMonth(now)
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1, 0, 0, 0, 0))
  } else {
    const parsed = new Date(windowAnchor)
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(
        `resolveClosedUtcWindow: unsupported windowAnchor '${windowAnchor}' ` +
          "(expected previous-closed-day|previous-closed-hour|previous-closed-week|previous-closed-month or ISO-8601 date).",
      )
    }
    if (windowKind === "point") {
      start = startOfUtcHour(parsed)
      end = new Date(start.getTime() + 3_600_000)
    } else if (windowKind === "day") {
      start = startOfUtcDay(parsed)
      end = new Date(start.getTime() + 86_400_000)
    } else if (windowKind === "week") {
      start = startOfUtcWeekMonday(parsed)
      end = new Date(start.getTime() + 7 * 86_400_000)
    } else {
      start = startOfUtcMonth(parsed)
      end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 0, 0, 0, 0))
    }
  }

  return {
    periodKind: windowKind,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    periodStartUnix: Math.floor(start.getTime() / 1000),
    periodEndUnix: Math.floor(end.getTime() / 1000),
  }
}

function assertNoExternalRef(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoExternalRef(v, `${path}[${i}]`))
    return
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.$ref === "string" && !obj.$ref.startsWith("#/")) {
    throw new Error(
      `External $ref '${obj.$ref}' at ${path} is forbidden in inline TOOL.md JSON Schema.`,
    )
  }
  for (const [k, v] of Object.entries(obj)) {
    assertNoExternalRef(v, `${path}.${k}`)
  }
}

/**
 * Convert a Zod v4 schema into an inline JSON Schema object safe for TOOL.md
 * frontmatter (no external `$ref`, no `$schema` header).
 */
export function zodToInlineJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>
  const { $schema: _ignored, ...rest } = raw
  assertNoExternalRef(rest)
  return rest
}

/**
 * Reconstruct a Zod v4 runtime schema from an inline JSON Schema object.
 */
export function jsonSchemaToZod(jsonSchema: Record<string, unknown>): ZodType<unknown> {
  assertNoExternalRef(jsonSchema)
  return z.fromJSONSchema(jsonSchema as Parameters<typeof z.fromJSONSchema>[0]) as ZodType<unknown>
}
