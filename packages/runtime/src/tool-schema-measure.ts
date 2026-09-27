/**
 * Pure sizing helper for a `tools/list` response — shared by
 * `scripts/measure-mcp-tools.mjs` (human-readable before/after report) and
 * the budget-guard test (`__tests__/tool-schema-budget.test.ts`) so both
 * measure the exact same thing: the JSON bytes an MCP client actually pays
 * for per tool (`description` + `inputSchema`), sorted biggest first.
 */

export interface MeasuredToolEntry {
  name: string
  bytes: number
}

export interface ToolListMeasurement {
  entries: MeasuredToolEntry[]
  totalBytes: number
}

export interface MeasurableTool {
  name: string
  description?: string
  inputSchema?: unknown
}

/** UTF-8 byte size of the `{description, inputSchema}` JSON a client
 *  receives for one tool — the same two fields `tools/list` sends over the
 *  wire, so this tracks prompt-token cost rather than just character count. */
export function measureTool(tool: MeasurableTool): number {
  return Buffer.byteLength(
    JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema }),
    "utf8",
  )
}

export function measureToolList(tools: readonly MeasurableTool[]): ToolListMeasurement {
  const entries = tools
    .map(t => ({ name: t.name, bytes: measureTool(t) }))
    .sort((a, b) => b.bytes - a.bytes)
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0)
  return { entries, totalBytes }
}
