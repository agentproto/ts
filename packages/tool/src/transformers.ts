import type { ZodRawShape } from "zod"
import {
  paginate,
  pageParamsShape,
  toolText,
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
}

/**
 * Pagination transformer — adds {@link pageParamsShape} to the input shape
 * and wraps the handler (which must return the FULL, unprojected item
 * array) with the shared cursor/limit semantics:
 *
 *  - `limit`/`cursor` present → the `{ items, nextCursor?, total }` page
 *    envelope via `paginate` + `toolText` (cursor/limit semantics are the
 *    exact ones the daemon's list tools already depend on).
 *  - neither present → the legacy `{ [itemKey]: [...] }` wrapper, no
 *    envelope fields.
 *
 * Rows are COMPACT by default (`project`); `full: true` / `compact: false`
 * returns the unprojected records. `fields` is a per-item allowlist
 * applied on the paginated envelope branch (matching existing behavior).
 */
export function paginated<TItem extends object>(
  opts: PaginatedOptions<TItem>,
): ToolTransformer<unknown, readonly TItem[], McpTextResult> {
  const { project, keyOf, maxLimit = 200, itemKey = "items" } = opts
  return {
    name: "paginated",
    wrapShape: (shape: ZodRawShape): ZodRawShape => ({ ...shape, ...pageParamsShape }),
    wrapHandler: handler => async input => {
      const params = (input ?? {}) as PageParams
      const items = (await handler(input)) as readonly TItem[]
      const full = params.full === true
      const compact = full ? false : params.compact !== false
      if (params.limit !== undefined || params.cursor !== undefined) {
        const page = paginate(items, params, { maxLimit, keyOf })
        return compact
          ? textResult(toolText({ ...page, items: page.items.map(project) }, params))
          : textResult(toolText(page, params))
      }
      const rows = compact ? items.map(project) : items
      return textResult(JSON.stringify({ [itemKey]: rows }))
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
