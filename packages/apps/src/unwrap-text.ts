/**
 * The one `unwrapText` the inline app panels (config, ops-panel,
 * session-viewer, media-viewer, mail-triage) embed in their page script via
 * `var unwrapText = ${unwrapText.toString()}`, so the function tested in
 * `__tests__/unwrap-text.test.ts` is the one the browser runs. Keep it
 * self-contained: no imports, no module-scope references.
 *
 * `app_tool_call` wraps its dispatch result at least once (its own text
 * result body is the JSON-stringified inner MCP tool result); this peels
 * nested `{content:[{type:"text",text:...}]}` shells until the payload stops
 * looking like one.
 *
 * The daemon's result-cap marker (`{truncated:true,totalBytes,hint}`,
 * `capResult` in packages/mcp-server/src/to-mcp-tool.ts) THROWS an Error
 * named `McpResultTruncatedError`: the payload is gone, and returning the
 * marker as data is what made panels render "nothing installed". Both the
 * error form current daemons send (an inner `isError` envelope) and the
 * successful form older daemons sent are caught. Any other error result
 * keeps its old behaviour (its text, parsed when it is JSON).
 */
export function unwrapText(result: unknown): unknown {
  function markerOf(v: unknown): { totalBytes: number; hint: string } | null {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null
    const o = v as { truncated?: unknown; totalBytes?: unknown; hint?: unknown }
    if (o.truncated !== true || typeof o.totalBytes !== "number") return null
    return { totalBytes: o.totalBytes, hint: typeof o.hint === "string" ? o.hint : "" }
  }
  function truncated(m: { totalBytes: number; hint: string }): Error {
    const err = new Error(
      "result truncated by the daemon's MCP result cap (" + m.totalBytes + " bytes)" + (m.hint ? "; " + m.hint : ""),
    )
    err.name = "McpResultTruncatedError"
    return Object.assign(err, { totalBytes: m.totalBytes })
  }
  let cur: unknown = result
  for (let i = 0; i < 4; i++) {
    if (typeof cur === "string") {
      try {
        cur = JSON.parse(cur)
        continue
      } catch (e) {
        return cur
      }
    }
    const env = cur as { content?: Array<{ text?: unknown }>; isError?: unknown } | null
    if (env && Array.isArray(env.content) && env.content[0] && typeof env.content[0].text === "string") {
      const text = env.content[0].text
      if (env.isError === true) {
        let parsed: unknown = null
        try {
          parsed = JSON.parse(text)
        } catch (e) {
          parsed = null
        }
        const m = markerOf(parsed)
        if (m) throw truncated(m)
      }
      cur = text
      continue
    }
    break
  }
  const m = markerOf(cur)
  if (m) throw truncated(m)
  return cur
}
