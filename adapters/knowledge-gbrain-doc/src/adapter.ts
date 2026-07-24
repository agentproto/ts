/**
 * GbrainDocKnowledgeAdapter — the `IKnowledgeProvider` over gbrain's DOCUMENT
 * API.
 *
 * Connects the `@agentproto/knowledge-engine` `IKnowledgeProvider` contract to a
 * gbrain server's document surface, reached over its JSON-RPC MCP endpoint
 * (`POST /mcp`, bearer-authenticated) via pure `fetch` — no vendor SDK. The two
 * load-bearing tools are `put_page` (ingest) and `search` (query); the
 * lifecycle verbs (`list_pages` / `get_page` / `delete_page`) round out the
 * contract. Lets a host plug "my own gbrain" as a first-class knowledge engine
 * alongside the files / corpus / qdrant backends.
 *
 * DISTINCT from `@agentproto/adapter-code-brain-gbrain`: that adapter is the
 * CODE-GRAPH one (`ICodeBrainProvider`: define / callers / callees). THIS one is
 * the KNOWLEDGE-DOC one (`IKnowledgeProvider` over gbrain's document store).
 * Same backend, different contract — they never share a package edge; gbrain is
 * reached only at runtime over HTTP.
 *
 * Lifted from the studio integration package
 * (`packages/integration/knowledge/src/providers/gbrain-knowledge.adapter.ts`).
 * Changes on the lift:
 *   1. The contract + data types now come from `@agentproto/knowledge-engine`
 *      (was the studio `../base-knowledge.provider` / `../../types`).
 *   2. The ONE cross-package edge — a type-only import of `JsonRpcRequest` /
 *      `JsonRpcResponse` from the studio `core/protocol` package
 *      (`gbrain-knowledge.adapter.ts:23`) — is replaced by the two inline
 *      interfaces below. No studio dependency survives.
 *   3. The wire shapes are typed against the LIVE gbrain doc API (probed at
 *      build time), which drifts from the studio original:
 *        - `put_page` args are `{ slug, content }` (studio sent a `source`
 *          field; gbrain's real field is the server-stamped `source_uri`).
 *        - `search` args are `{ query, limit, offset }` (studio sent a
 *          `min_score` gbrain doesn't accept — `minScore` is applied
 *          client-side here instead).
 *        - a `search` hit carries `chunk_text` / `score` / `chunk_index`
 *          (studio expected `snippet` / `rerank_score`).
 *      Every response is zod-parsed — nothing untyped reaches a call site.
 *
 * Scope of this adapter:
 *   - `ingest({ kind, uri, title?, content })` — `put_page` a markdown doc
 *   - `query({ query, topK, minScore })` — `search` (gbrain fuses lexical +
 *     semantic recall, so `modeUsed` is stamped `"hybrid"`)
 *   - `listSources()` / `getSource(id)` / `deleteSource(id)` — via
 *     `list_pages` / `get_page` / `delete_page`
 *   - `healthCheck()` — `GET /health` returns OK
 */

import { z } from "zod"
import type {
  IKnowledgeProvider,
  KnowledgeCapabilities,
  KnowledgeHit,
  KnowledgeIngestInput,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeSource,
  KnowledgeSourceKind,
  ListSourcesFilter,
} from "@agentproto/knowledge-engine"

export const GBRAIN_DOC_ENGINE_ID = "gbrain-doc" as const

// ── Inline JSON-RPC 2.0 wire types ──────────────────────────────────
//
// Replaces the studio adapter's ONE cross-package edge: a type-only import of
// `JsonRpcRequest` / `JsonRpcResponse` from the studio `core/protocol` package.
// gbrain speaks JSON-RPC 2.0 over `POST /mcp`; these two frames are all we send
// and receive, so they inline here with zero new dependency. The response is
// additionally zod-validated on the wire ({@link mcpEnvelopeSchema}) so nothing
// untyped reaches a call site.

/** A JSON-RPC 2.0 request frame — the body we POST to gbrain's `/mcp`. */
interface JsonRpcRequest<TParams = unknown> {
  readonly jsonrpc: "2.0"
  readonly id: number
  readonly method: string
  readonly params?: TParams
}

/** A JSON-RPC 2.0 response frame — success carries `result`, failure `error`. */
interface JsonRpcResponse<TResult = unknown> {
  readonly jsonrpc?: "2.0"
  readonly id?: number | string | null
  readonly result?: TResult
  readonly error?: { readonly code?: number; readonly message: string }
}

// ── Config ──────────────────────────────────────────────────────────

export const GbrainDocAdapterConfigSchema = z.object({
  /** Base URL of the gbrain HTTP server (no trailing slash needed). The
   *  JSON-RPC `/mcp` endpoint is appended. */
  endpoint: z.string().url(),
  /** Machine bearer token accepted by the gbrain server (`GBRAIN_BEARER_TOKEN`).
   *  Required — the `/mcp` endpoint is OAuth 2.1 / bearer-protected. */
  bearerToken: z.string().min(1),
  /** Per-request timeout (ms). Default 45_000. */
  timeoutMs: z.number().int().positive().default(45_000),
  /** Optional human label for logs. */
  label: z.string().optional(),
})

export type GbrainDocAdapterConfig = z.infer<typeof GbrainDocAdapterConfigSchema>

export function parseGbrainDocAdapterConfig(
  raw: Readonly<Record<string, unknown>>,
): GbrainDocAdapterConfig {
  return GbrainDocAdapterConfigSchema.parse(raw)
}

// ── Capabilities ────────────────────────────────────────────────────

export const GBRAIN_DOC_CAPABILITIES: KnowledgeCapabilities = Object.freeze({
  // gbrain `search` fuses lexical (tsvector) + semantic recall, so both the
  // vector + hybrid flags are honest.
  vectorSearch: true,
  hybridSearch: true,
  // This adapter drives the DOCUMENT surface (put_page / search); it does NOT
  // reach gbrain's graph traversal (`traverse_graph` / `query`).
  graphTraversal: false,
  multiModal: false,
  streaming: false,
  citations: true,
  // gbrain caps a `/mcp` request body at 1 MiB; keep a chunk comfortably inside.
  maxChunkBytes: 64 * 1024,
})

// ── Wire shapes (zod-parsed — nothing untyped reaches a call site) ───

/** The MCP `tools/call` result envelope: a text block (+ optional structured
 *  content) and an `isError` flag gbrain sets for e.g. page-not-found. */
const mcpToolResultSchema = z.object({
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
})

type McpToolResult = z.infer<typeof mcpToolResultSchema>

/** The JSON-RPC envelope wrapping an MCP `tools/call` result. Mirrors the
 *  inline {@link JsonRpcResponse} interface, validated on the wire. */
const mcpEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: mcpToolResultSchema.optional(),
  error: z
    .object({ code: z.number().optional(), message: z.string() })
    .optional(),
})

/** A single `search` hit row (gbrain doc API). Known fields are typed; the rest
 *  (page_id, type, source_id, evidence, …) flow through to `metadata`. */
const searchHitSchema = z
  .object({
    slug: z.string(),
    chunk_text: z.string().optional(),
    chunk_index: z.number().optional(),
    chunk_id: z.union([z.number(), z.string()]).optional(),
    score: z.number().optional(),
    base_score: z.number().optional(),
  })
  .catchall(z.unknown())

/** `search` returns a bare array of hits; some builds wrap it as `{ results }`.
 *  Accept both. */
const searchResultSchema = z.union([
  z.array(searchHitSchema),
  z.object({ results: z.array(searchHitSchema) }),
])

/** `put_page` result — status + chunk count (+ passthrough backstop fields). */
const putPageResultSchema = z
  .object({
    slug: z.string().optional(),
    status: z.string().optional(),
    chunks: z.number().optional(),
  })
  .catchall(z.unknown())

/** A `get_page` document envelope. */
const pageSchema = z
  .object({
    slug: z.string(),
    type: z.string().optional(),
    title: z.string().optional(),
    compiled_truth: z.string().optional(),
    source_uri: z.string().nullish(),
    updated_at: z.string().optional(),
    created_at: z.string().optional(),
  })
  .catchall(z.unknown())

/** A `list_pages` row (slim: no body). */
const pageListItemSchema = z
  .object({
    slug: z.string(),
    type: z.string().optional(),
    title: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .catchall(z.unknown())

const pageListSchema = z.union([
  z.array(pageListItemSchema),
  z.object({ pages: z.array(pageListItemSchema) }),
])

// ── Adapter ──────────────────────────────────────────────────────────

export class GbrainDocKnowledgeAdapter implements IKnowledgeProvider {
  readonly id = GBRAIN_DOC_ENGINE_ID
  readonly capabilities = GBRAIN_DOC_CAPABILITIES

  private readonly endpoint: string
  private readonly bearerToken: string
  private readonly timeoutMs: number
  private readonly label?: string

  private rpcCounter = 0

  constructor(config: GbrainDocAdapterConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, "")
    this.bearerToken = config.bearerToken
    this.timeoutMs = config.timeoutMs
    this.label = config.label
  }

  async ingest(input: KnowledgeIngestInput): Promise<KnowledgeSource> {
    const content = normalizeContent(input.content)
    if (!content.trim()) {
      throw new Error(
        `GbrainDocKnowledgeAdapter: ingest payload is empty (uri=${input.uri}); gbrain put_page requires document content.`,
      )
    }
    const slug = deriveSlug(input)
    // gbrain put_page takes { slug, content }. `source_uri` is SERVER-STAMPED
    // for remote callers (client value ignored), so we don't send it — the
    // caller's uri round-trips through the returned KnowledgeSource instead.
    const result = await this.callTool("put_page", { slug, content })
    const parsed = putPageResultSchema.parse(parseToolJson(result))
    return {
      id: parsed.slug ?? slug,
      kind: input.kind,
      uri: input.uri,
      title: input.title,
      bytes: byteLength(content),
      status: "ready",
      indexedAt: new Date(),
      metadata: {
        ...(input.metadata ?? {}),
        gbrainStatus: parsed.status ?? "created_or_updated",
        ...(parsed.chunks !== undefined ? { chunks: parsed.chunks } : {}),
      },
    }
  }

  async query(q: KnowledgeQuery): Promise<KnowledgeQueryResult> {
    const start = Date.now()
    // `"none"` is the cold-start sentinel — skip retrieval entirely.
    if (q.mode === "none") {
      return { engine: this.id, modeUsed: "none", hits: [], tookMs: 0 }
    }

    const args: Record<string, number | string> = { query: q.query }
    if (q.topK !== undefined) args.limit = q.topK

    const result = await this.callTool("search", args)
    const parsed = searchResultSchema.parse(parseToolJson(result))
    const rows = Array.isArray(parsed) ? parsed : parsed.results

    let hits: KnowledgeHit[] = rows.map((row, i) => searchRowToHit(row, i))
    // gbrain `search` has no server-side score floor, so honour `minScore`
    // client-side (the contract lets adapters enforce it either way).
    if (q.minScore !== undefined) {
      const floor = q.minScore
      hits = hits.filter((h) => h.score >= floor)
    }

    return {
      engine: this.id,
      // gbrain search fuses lexical + semantic recall — surface the real mode
      // regardless of the caller's hint.
      modeUsed: "hybrid",
      hits,
      tookMs: Date.now() - start,
    }
  }

  async listSources(
    filter?: ListSourcesFilter,
  ): Promise<readonly KnowledgeSource[]> {
    const args: Record<string, string> = {}
    if (filter?.kind) args.type = kindToGbrainType(filter.kind)
    const result = await this.callTool("list_pages", args)
    const parsed = pageListSchema.parse(parseToolJson(result))
    const rows = Array.isArray(parsed) ? parsed : parsed.pages
    let out = rows.map((row) => listItemToSource(row, filter?.kind))
    // `status` isn't a gbrain list dimension — every listed page is live, so a
    // `status` filter keeps only "ready" (all of them) or nothing.
    if (filter?.status) out = out.filter((s) => s.status === filter.status)
    return out
  }

  async getSource(id: string): Promise<KnowledgeSource | null> {
    try {
      const result = await this.callTool("get_page", { slug: id })
      const parsed = pageSchema.parse(parseToolJson(result))
      return pageToSource(parsed)
    } catch (err) {
      // gbrain flags a missing page with isError + a "page_not_found" body —
      // fold that to null; re-throw anything else.
      if (isNotFound(err)) return null
      throw err
    }
  }

  async deleteSource(id: string): Promise<void> {
    try {
      await this.callTool("delete_page", { slug: id })
    } catch (err) {
      // Deleting an already-absent page is a no-op, not an error.
      if (isNotFound(err)) return
      throw err
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/health`, {
        method: "GET",
        headers: this.authHeaders(),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async dispose(): Promise<void> {
    // No connections to tear down — gbrain calls are stateless JSON-RPC over
    // HTTP. Kept on the interface for adapters that hold long-lived clients.
  }

  // ── Internal: MCP / JSON-RPC plumbing ────────────────────────────

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.bearerToken}`,
      "Content-Type": "application/json",
      // gbrain serves `/mcp` as MCP Streamable HTTP; the client MUST declare it
      // accepts BOTH JSON and event-stream or the server answers 406.
      Accept: "application/json, text/event-stream",
    }
  }

  private nextRpcId(): number {
    this.rpcCounter += 1
    return this.rpcCounter
  }

  /** Issue one MCP `tools/call` and return the parsed result envelope. Throws a
   *  labelled error when gbrain sets `isError` (e.g. page-not-found). */
  private async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpToolResult> {
    const envelope = await this.rpcCall("tools/call", { name, arguments: args })
    if (envelope.error !== undefined) {
      throw new Error(this.errPrefix(`tool ${name}: ${envelope.error.message}`))
    }
    const result = envelope.result
    if (result === undefined) {
      throw new Error(this.errPrefix(`tool ${name} returned no result`))
    }
    if (result.isError) {
      throw new Error(this.errPrefix(`tool ${name}: ${readToolError(result)}`))
    }
    return result
  }

  private async rpcCall(
    method: string,
    params: unknown,
  ): Promise<z.infer<typeof mcpEnvelopeSchema>> {
    const body: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextRpcId(),
      method,
      params,
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.endpoint}/mcp`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => "")
        throw new Error(
          this.errPrefix(
            `${method} → HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
          ),
        )
      }
      // gbrain replies as a Streamable-HTTP SSE frame (`data: {…}`) OR plain
      // JSON — {@link extractJsonRpcPayload} normalises both.
      const raw = await res.text()
      return mcpEnvelopeSchema.parse(JSON.parse(extractJsonRpcPayload(raw)))
    } finally {
      clearTimeout(timer)
    }
  }

  private errPrefix(msg: string): string {
    const labelPart = this.label ? ` (${this.label})` : ""
    return `GbrainDocKnowledgeAdapter${labelPart}: ${msg}`
  }
}

/** Construct a {@link GbrainDocKnowledgeAdapter} from a validated config. */
export function gbrainDocKnowledgeAdapter(
  config: GbrainDocAdapterConfig,
): GbrainDocKnowledgeAdapter {
  return new GbrainDocKnowledgeAdapter(config)
}

// ── Pure helpers (no I/O) — exported where a test drives them ─────────

/**
 * Extract the JSON-RPC envelope from a Streamable-HTTP response body. gbrain
 * replies with SSE frames (`event: message\ndata: {…}`); the last non-empty
 * `data:` line carries the JSON-RPC payload. A plain-JSON body (no SSE framing)
 * is returned whole.
 */
export function extractJsonRpcPayload(body: string): string {
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((payload) => payload.length > 0)
  const last = dataLines[dataLines.length - 1]
  return last ?? body.trim()
}

/**
 * Pull the JSON payload out of an MCP tool result: prefer `structuredContent`,
 * else the first text block parsed as JSON. Returns the raw text when it isn't
 * JSON. The caller zod-parses the returned value into a concrete shape.
 */
function parseToolJson(result: McpToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent
  const first = result.content?.find((c) => c.text !== undefined && c.text !== "")
  if (first?.text === undefined) return null
  try {
    return JSON.parse(first.text)
  } catch {
    return first.text
  }
}

/** The error text gbrain packs into a `tools/call` result when `isError` is set. */
function readToolError(result: McpToolResult): string {
  const first = result.content?.find((c) => c.text !== undefined && c.text !== "")
  return first?.text ?? "unknown error"
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /not.?found/i.test(err.message)
}

type SearchRow = z.infer<typeof searchHitSchema>

function searchRowToHit(row: SearchRow, index: number): KnowledgeHit {
  const { slug, chunk_text, chunk_index, chunk_id, score, base_score, ...rest } =
    row
  const chunkIndex = chunk_index ?? index
  return {
    sourceId: slug,
    chunkId:
      chunk_id !== undefined ? `${slug}#${chunk_id}` : `${slug}#${chunkIndex}`,
    text: chunk_text ?? "",
    score: score ?? base_score ?? 0,
    // Round-trip every other gbrain field (title, type, page_id, source_id,
    // evidence, …) so a hit carries full provenance to the LLM.
    metadata: { chunkIndex, ...rest },
  }
}

type PageRow = z.infer<typeof pageSchema>

function pageToSource(page: PageRow): KnowledgeSource {
  const compiled = page.compiled_truth ?? ""
  return {
    id: page.slug,
    kind: gbrainTypeToKind(page.type),
    uri: page.source_uri ?? page.slug,
    title: page.title,
    bytes: byteLength(compiled),
    status: "ready",
    indexedAt: parseDate(page.updated_at ?? page.created_at),
    metadata: { type: page.type ?? "note" },
  }
}

type PageListRow = z.infer<typeof pageListItemSchema>

function listItemToSource(
  row: PageListRow,
  hintedKind?: KnowledgeSourceKind,
): KnowledgeSource {
  return {
    id: row.slug,
    kind: hintedKind ?? gbrainTypeToKind(row.type),
    uri: row.slug,
    title: row.title,
    // list_pages is a slim projection (no body) — bytes are unknown here.
    bytes: 0,
    status: "ready",
    indexedAt: parseDate(row.updated_at),
    metadata: { type: row.type ?? "note" },
  }
}

function deriveSlug(input: KnowledgeIngestInput): string {
  if (input.title) return slugify(input.title)
  const [pathPart = ""] = input.uri.split(/[?#]/)
  const tail = pathPart.split("/").filter(Boolean).pop()
  if (tail) return slugify(tail)
  return "note"
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "note"
  )
}

function gbrainTypeToKind(t: string | undefined): KnowledgeSourceKind {
  if (!t) return "text"
  if (t === "url" || t === "link") return "url"
  if (t === "file" || t === "document" || t === "code") return "file"
  if (t === "connector") return "connector"
  return "text"
}

function kindToGbrainType(kind: KnowledgeSourceKind): string {
  switch (kind) {
    case "url":
      return "url"
    case "file":
      return "file"
    case "connector":
      return "connector"
    case "text":
    default:
      return "note"
  }
}

function normalizeContent(content: KnowledgeIngestInput["content"]): string {
  if (content === undefined) return ""
  if (typeof content === "string") return content
  return new TextDecoder().decode(content)
}

/** UTF-8 byte length without a `node:buffer` edge — runs on edge runtimes too. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function parseDate(v: string | undefined): Date | undefined {
  if (v === undefined) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}
