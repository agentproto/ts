import type { ZodRawShape } from "zod"
import {
  paginate,
  pageParamsShape,
  PAGE_LIMIT_MAX,
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
  /** Hard ceiling on `limit` (default and maximum {@link PAGE_LIMIT_MAX}:
   *  the shared input schema rejects a larger `limit`, so a higher ceiling
   *  would be dead configuration and throws at registration). */
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
   * `{ total, partial: true, nextCursor }` so the caller can page on, which
   * keeps a tool whose rows pile up (terminals) under the MCP output cap.
   * `partial` is the "first page of many" flag; the same wrapper still
   * carries `truncated: true` as a deprecated alias for readers written
   * against it. It is NOT the MCP result-cap marker (`{ truncated,
   * totalBytes, hint }`, sent as an error result by `capResult` in
   * `@agentproto/mcp-server`).
   */
  defaultLimit?: number
  /**
   * Body of the NON-paginated call, built from the rendered rows (compact
   * projection and `fields` already applied). Default
   * `{ [itemKey]: rows }` (plus `total` with `includeTotal`). For list tools
   * whose legacy unpaged answer is a bare array (`rows => rows`) or carries
   * fields beside the rows (`(rows, input) => ({ boardId, tasks: rows })`).
   * Not used on the `defaultLimit` first page.
   */
  defaultBody?: (rows: object[], input: unknown) => unknown
  /**
   * Fields merged into the paged envelope and the `defaultLimit` first page
   * (e.g. `task_list`'s `boardId`), so a caller that pages keeps what the
   * unpaged body carries.
   */
  pageExtra?: (input: unknown) => object
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
 * A handler output that is not an array (a tool's own error result) passes
 * through untouched.
 *
 * Rows are COMPACT by default (`project`); `full: true` / `compact: false`
 * returns the unprojected records. `fields` is a per-item allowlist
 * applied on every branch (paginated, first page, plain wrapper and
 * `defaultBody`).
 * An explicit `fields` list is itself a projection, bounded by what the
 * caller names, so on that branch it is applied to the FULL record and the
 * compact projection is skipped (unless `compact: true` is explicit) —
 * otherwise a requested field outside the compact set is silently dropped.
 */
export function paginated<TItem extends object>(
  opts: PaginatedOptions<TItem>,
): ToolTransformer<unknown, readonly TItem[], McpTextResult> {
  const { project, keyOf, maxLimit = PAGE_LIMIT_MAX, itemKey = "items", defaultLimit, includeTotal, defaultBody, pageExtra } = opts
  if (maxLimit > PAGE_LIMIT_MAX) {
    throw new Error(
      `paginated(): maxLimit ${maxLimit} is above the largest limit the page schema accepts (${PAGE_LIMIT_MAX}); it could never be reached`,
    )
  }
  return {
    name: "paginated",
    wrapShape: (shape: ZodRawShape): ZodRawShape => ({ ...shape, ...pageParamsShape }),
    wrapHandler: handler => async input => {
      const params = (input ?? {}) as PageParams
      const out: unknown = await handler(input)
      if (!Array.isArray(out)) return out as McpTextResult
      const items = out as readonly TItem[]
      const extra = (): object => (pageExtra ? pageExtra(input) : {})
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
        return textResult(JSON.stringify({ ...extra(), ...page, items: render(page.items) }))
      }
      if (defaultLimit !== undefined && items.length > defaultLimit) {
        const page = paginate(items, { limit: defaultLimit }, { maxLimit: Math.max(maxLimit, defaultLimit), keyOf })
        return textResult(
          JSON.stringify({
            ...extra(),
            [itemKey]: render(page.items),
            total: page.total,
            partial: true,
            // Deprecated alias of `partial` (see `defaultLimit`).
            truncated: true,
            nextCursor: page.nextCursor,
          }),
        )
      }
      if (defaultBody) return textResult(JSON.stringify(defaultBody(render(items), input)))
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
