import type { ZodRawShape } from "zod"
import {
  paginate,
  pageParamsShape,
  type PageParams,
} from "./envelope.js"
import type { ToolTransformer } from "./types.js"

/**
 * Concrete {@link ToolTransformer}s — cross-cutting concerns composed by
 * MCP-facing adapters (`toMcpTool`) around a tool's handler pipeline.
 */

/** The MCP text-result shape transformers terminate the pipeline into. */
export interface McpTextResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

function textResult(text: string): McpTextResult {
  return { content: [{ type: "text", text }] }
}

export interface PaginatedOptions<TItem> {
  /**
   * REQUIRED per-item compact projection. Requiring it is the point: there
   * is no code path that accepts the `compact` param without an actual
   * compact projection behind it, killing the "declared but dead param"
   * bug class. Pass the identity function only if you truly want
   * `compact` to be a no-op.
   */
  project: (item: TItem) => object
  /** Key function for the opaque pagination cursor. */
  keyOf?: (item: TItem) => string | number | null
  /** Hard ceiling on `limit` (default 200 — matches the daemon tools). */
  maxLimit?: number
  /**
   * Wrapper key for the NON-paginated output. With no `limit`/`cursor`,
   * legacy list tools returned `{ sessions: [...] }` rather than the page
   * envelope; set this to reproduce that wrapper (default `"items"`).
   */
  itemKey?: string
  /**
   * Row cap for the NON-paginated (no `limit`/`cursor`) call. Unset = the
   * legacy unbounded `{ [itemKey]: [...] }`. When set and the list is longer,
   * the wrapper carries the first `defaultLimit` rows plus
   * `{ total, truncated: true, nextCursor }` so the caller can page on —
   * keeps a tool whose rows pile up (terminals) under the MCP output cap.
   */
  defaultLimit?: number
  /**
   * Add `total` (the size of the list the handler returned, i.e. after any
   * filtering) to the NON-paginated wrapper too. Default off: the legacy
   * `{ [itemKey]: [...] }` shape stays byte-identical for existing tools.
   */
  includeTotal?: boolean
}

/**
 * Pagination transformer — adds {@link pageParamsShape} to the input shape
 * and wraps the handler (which must return the FULL, unprojected item
 * array) with the shared cursor/limit semantics:
 *
 *  - `limit`/`cursor` present → the `{ items, nextCursor?, total }` page
 *    envelope via `paginate` (cursor/limit semantics are the
 *    exact ones the daemon's list tools already depend on).
 *  - neither present → the legacy `{ [itemKey]: [...] }` wrapper, no
 *    envelope fields (unless `includeTotal` adds `total`).
 *
 * Rows are COMPACT by default (`project`); `full: true` / `compact: false`
 * returns the unprojected records. `fields` is a per-item allowlist
 * applied on every branch (paginated, truncated and plain wrapper).
 * An explicit `fields` list is itself a projection, bounded by what the
 * caller names, so on that branch it is applied to the FULL record and the
 * compact projection is skipped (unless `compact: true` is explicit) —
 * otherwise a requested field outside the compact set is silently dropped.
 */
export function paginated<TItem extends object>(
  opts: PaginatedOptions<TItem>,
): ToolTransformer<unknown, readonly TItem[], McpTextResult> {
  const { project, keyOf, maxLimit = 200, itemKey = "items", defaultLimit, includeTotal } = opts
  return {
    name: "paginated",
    wrapShape: (shape: ZodRawShape): ZodRawShape => ({ ...shape, ...pageParamsShape }),
    wrapHandler: handler => async input => {
      const params = (input ?? {}) as PageParams
      const items = (await handler(input)) as readonly TItem[]
      const full = params.full === true
      const compact = full ? false : params.compact !== false
      const projectRows = compact && (params.fields === undefined || params.compact === true)
      const render = (rows: readonly TItem[]): object[] => {
        const projected = projectRows ? rows.map(project) : [...rows]
        const fields = params.fields
        return fields === undefined
          ? projected
          : projected.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => fields.includes(key))))
      }
      if (params.limit !== undefined || params.cursor !== undefined) {
        const page = paginate(items, params, { maxLimit, keyOf })
        return textResult(JSON.stringify({ ...page, items: render(page.items) }))
      }
      if (defaultLimit !== undefined && items.length > defaultLimit) {
        const page = paginate(items, { limit: defaultLimit }, { maxLimit: Math.max(maxLimit, defaultLimit), keyOf })
        return textResult(
          JSON.stringify({
            [itemKey]: render(page.items),
            total: page.total,
            truncated: true,
            nextCursor: page.nextCursor,
          }),
        )
      }
      return textResult(
        JSON.stringify({ [itemKey]: render(items), ...(includeTotal ? { total: items.length } : {}) }),
      )
    },
  }
}

/**
 * Error-normalization transformer — wraps the handler so ANY thrown error
 * becomes the single canonical MCP error result
 * `{ content: [{ type: "text", text: <message> }], isError: true }`,
 * replacing the ~150 copy-pasted inline catch blocks.
 */
export function catchErrors(): ToolTransformer<unknown, unknown, McpTextResult> {
  return {
    name: "catchErrors",
    wrapHandler: handler => async input => {
      try {
        return (await handler(input)) as McpTextResult
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text", text }], isError: true }
      }
    },
  }
}
