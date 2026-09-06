import { z } from "zod"

/** Shared pagination params, spread into every list tool's input schema. */
export interface PageParams {
  limit?: number
  cursor?: string
  since?: number
  compact?: boolean
  full?: boolean
  fields?: string[]
}

export interface Page<T> {
  items: T[]
  nextCursor?: string
  total?: number
  truncated?: boolean
}

/** Opaque cursor: base64(JSON `{ k: keysetValue, i: index }`). */
export interface CursorPayload {
  k: string | number | null
  i: number
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
}

const cursorPayloadSchema = z.object({
  k: z.union([z.string(), z.number(), z.null()]),
  i: z.number().int().min(0),
})

/** No `unknown`/`as`: the JSON boundary is typed by zod's safeParse/parse. */
export function decodeCursor(token: string): CursorPayload | null {
  let text: string
  try {
    text = Buffer.from(token, "base64url").toString("utf8")
  } catch {
    return null
  }
  try {
    return cursorPayloadSchema.parse(JSON.parse(text))
  } catch {
    return null
  }
}

export interface PaginateOpts<T> {
  maxLimit: number
  keyOf?: (item: T) => string | number | null
}

export function paginate<T>(items: readonly T[], params: PageParams, opts: PaginateOpts<T>): Page<T> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), opts.maxLimit)
  let start = 0
  if (params.cursor) {
    const decoded = decodeCursor(params.cursor)
    if (decoded && decoded.i >= 0 && decoded.i <= items.length) start = decoded.i
  }
  const end = start + limit
  const slice = items.slice(start, end)
  const keyAt = (idx: number): string | number | null => {
    const item = items[idx]
    return opts.keyOf && item !== undefined ? opts.keyOf(item) : null
  }
  return {
    items: slice,
    ...(end < items.length ? { nextCursor: encodeCursor({ k: keyAt(end), i: end }) } : {}),
    total: items.length,
  }
}

/**
 * Compact serializer — replaces every `JSON.stringify(x, null, 2)` in list handlers.
 *
 * When `params.fields` is supplied, an explicit allowlist is applied to every
 * item (mechanically, across all call sites): items keep only the named keys.
 * Absent `fields`, the output is byte-identical to `JSON.stringify(page)`.
 */
export function toolText<T extends object>(page: Page<T>, params?: Pick<PageParams, "fields">): string {
  const fields = params?.fields
  const items =
    fields === undefined
      ? page.items
      : page.items.map(item =>
          Object.fromEntries(
            Object.entries(item).filter(([key]) => fields.includes(key)),
          ),
        )
  return JSON.stringify({ ...page, items })
}

/** Zod fragment to spread into each list tool's input schema. */
export const pageParamsShape = {
  limit: z.number().int().min(1).max(200).optional().describe("Max items per page. Default 50."),
  cursor: z.string().optional().describe("Opaque token from a prior call's `nextCursor`."),
  compact: z
    .boolean()
    .optional()
    .describe(
      "Compact projection (fewer fields per item). Default true on tools " +
        "that define a compact projection (session_list); a no-op elsewhere.",
    ),
  full: z
    .boolean()
    .optional()
    .describe(
      "Escape hatch — full, unprojected records (opts out of compact). " +
        "Default false.",
    ),
  fields: z.array(z.string()).optional().describe("Keep only these fields per item."),
} as const
