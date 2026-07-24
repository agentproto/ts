/**
 * Parsers that translate gbrain's raw output shapes into the pure
 * {@link ICodeBrainProvider} contract types. This module is the ONLY place
 * that knows what gbrain's JSON/text looks like; both the local (docker exec)
 * and HTTP (MCP) backends funnel their raw payloads through here.
 *
 * Two backends, two dialects — verified against the live `gbrain-pg`
 * container (v0.42.62.0) and captured as fixtures in `__fixtures__/`:
 *
 *   | contract     | CLI (`gbrain …`)        | HTTP MCP (`tools/call`)     |
 *   |--------------|-------------------------|-----------------------------|
 *   | defineSymbol | `{ …, "results": [ ] }` | `{ …, "defs": [ ] }`        |
 *   | callers      | `{ …, "callers": [ ] }` | `{ …, "callers": [ ] }`     |
 *   | callees      | `{ …, "callees": [ ] }` | `{ …, "callees": [ ] }`     |
 *   | graphQuery   | text lines `[s] slug …` | JSON array of hit objects   |
 *
 * gbrain's code-edge rows carry NO source location (no file/line on the
 * edge itself), so {@link CallEdge.file} is emitted as `""` and
 * {@link CallEdge.span} as a zero span — a documented gbrain limitation,
 * not a parser gap.
 */

import { z } from "zod"
import type {
  CallEdge,
  GraphHit,
  SourceSpan,
  SymbolDef,
} from "@agentproto/code-brain"

/** A definition site as gbrain returns it (CLI `results[]` / HTTP `defs[]`). */
const gbrainDefSiteSchema = z.object({
  slug: z.string(),
  file: z.string(),
  language: z.string(),
  symbol_type: z.string(),
  start_line: z.number().int().nonnegative(),
  end_line: z.number().int().nonnegative(),
  snippet: z.string(),
})

/** The `code-def` / `code_def` envelope — `results` (CLI) or `defs` (HTTP). */
const gbrainDefEnvelopeSchema = z.object({
  symbol: z.string(),
  count: z.number().int().nonnegative(),
  status: z.string(),
  ready: z.boolean(),
  results: z.array(gbrainDefSiteSchema).optional(),
  defs: z.array(gbrainDefSiteSchema).optional(),
})

/** A single code-edge row from `code-callers` / `code-callees`. */
const gbrainCallEdgeSchema = z.object({
  from_symbol_qualified: z.string(),
  to_symbol_qualified: z.string(),
})

/** The `code-callers` / `code-callees` envelope. */
const gbrainCallEnvelopeSchema = z.object({
  symbol: z.string(),
  count: z.number().int().nonnegative(),
  status: z.string(),
  ready: z.boolean(),
  callers: z.array(gbrainCallEdgeSchema).optional(),
  callees: z.array(gbrainCallEdgeSchema).optional(),
})

/** One hit from the HTTP `query` tool's JSON array. */
const gbrainHttpQueryHitSchema = z.object({
  slug: z.string(),
  title: z.string(),
  chunk_text: z.string(),
  score: z.number(),
})
const gbrainHttpQueryResultSchema = z.array(gbrainHttpQueryHitSchema)

const ZERO_SPAN: SourceSpan = { startLine: 0, endLine: 0 }

/**
 * Pull a `file` + `span` out of a gbrain snippet/chunk header of the form
 * `[TypeScript] packages/foo/bar.ts:34-161 …`. Returns an empty object when
 * the text carries no such header (so the contract's optional fields stay
 * absent rather than fabricated).
 */
export function extractLocation(text: string): {
  file?: string
  span?: SourceSpan
} {
  const match = text.match(/\[[^\]]+\]\s+(\S+):(\d+)-(\d+)\b/)
  if (match === null) return {}
  const file = match[1]
  const startRaw = match[2]
  const endRaw = match[3]
  if (file === undefined || startRaw === undefined || endRaw === undefined) {
    return {}
  }
  const startLine = Number.parseInt(startRaw, 10)
  const endLine = Number.parseInt(endRaw, 10)
  if (Number.isNaN(startLine) || Number.isNaN(endLine)) return {}
  return { file, span: { startLine, endLine } }
}

/**
 * Parse a `code-def` / `code_def` payload into a single {@link SymbolDef},
 * or `null` when gbrain resolved nothing. When several definition sites are
 * returned, the first (highest-ranked) is used — the contract resolves one
 * symbol to one definition.
 */
export function parseSymbolDef(
  symbol: string,
  jsonText: string,
): SymbolDef | null {
  const envelope = gbrainDefEnvelopeSchema.parse(JSON.parse(jsonText))
  const sites = envelope.results ?? envelope.defs ?? []
  const site = sites[0]
  if (site === undefined) return null
  return {
    symbol: envelope.symbol.length > 0 ? envelope.symbol : symbol,
    kind: site.symbol_type,
    file: site.file,
    span: { startLine: site.start_line, endLine: site.end_line },
    signature: site.snippet.trim(),
  }
}

/**
 * Parse a `code-callers` / `code-callees` payload into {@link CallEdge}s.
 * `direction` selects which array to read and which contract-facing meaning
 * the edge endpoints carry (see the map at the top of this file). gbrain
 * edges carry no location, so `file`/`span` are stubbed and documented.
 */
export function parseCallEdges(
  jsonText: string,
  direction: "callers" | "callees",
): CallEdge[] {
  const envelope = gbrainCallEnvelopeSchema.parse(JSON.parse(jsonText))
  const edges = (direction === "callers" ? envelope.callers : envelope.callees) ?? []
  return edges.map((edge) => ({
    from: edge.from_symbol_qualified,
    to: edge.to_symbol_qualified,
    file: "",
    span: ZERO_SPAN,
  }))
}

const CLI_HIT_HEADER = /^\[(\d*\.?\d+)\]\s+(\S+)\s+--\s?(.*)$/

/**
 * Parse the CLI `gbrain query` text output — one hit per `[score] slug --
 * snippet` header, with the snippet optionally continuing on the lines that
 * follow until the next header. Location is recovered from the snippet's
 * `[Lang] path:start-end` prefix when present.
 */
export function parseQueryText(text: string): GraphHit[] {
  const lines = text.split("\n")
  const hits: GraphHit[] = []
  let current: { score: number; slug: string; bodyLines: string[] } | null = null

  const flush = (): void => {
    if (current === null) return
    const body = current.bodyLines.join("\n").trim()
    const location = extractLocation(body)
    hits.push({
      title: current.slug,
      body,
      score: current.score,
      ...(location.file !== undefined ? { file: location.file } : {}),
      ...(location.span !== undefined ? { span: location.span } : {}),
    })
    current = null
  }

  for (const line of lines) {
    const header = line.match(CLI_HIT_HEADER)
    if (header !== null) {
      flush()
      const score = Number.parseFloat(header[1] ?? "")
      current = {
        score: Number.isNaN(score) ? 0 : score,
        slug: header[2] ?? "",
        bodyLines: [header[3] ?? ""],
      }
    } else if (current !== null) {
      current.bodyLines.push(line)
    }
  }
  flush()
  return hits
}

/**
 * Parse the HTTP `query` tool's JSON-array output into {@link GraphHit}s.
 * Location is recovered from each hit's `chunk_text` header when present.
 */
export function parseQueryJson(jsonText: string): GraphHit[] {
  const rows = gbrainHttpQueryResultSchema.parse(JSON.parse(jsonText))
  return rows.map((row) => {
    const location = extractLocation(row.chunk_text)
    return {
      title: row.title,
      body: row.chunk_text,
      score: row.score,
      ...(location.file !== undefined ? { file: location.file } : {}),
      ...(location.span !== undefined ? { span: location.span } : {}),
    }
  })
}
