/**
 * Re-export of the shared pagination primitives, which now live on the
 * AIP contract layer (`@agentproto/tool`) so the `paginated()` tool
 * transformer can reuse the exact cursor/limit semantics. All existing
 * `./tool-envelope.js` imports keep working unchanged.
 */
export {
  paginate,
  toolText,
  encodeCursor,
  decodeCursor,
  pageParamsShape,
  type Page,
  type PageParams,
  type PaginateOpts,
  type CursorPayload,
} from "@agentproto/tool"
