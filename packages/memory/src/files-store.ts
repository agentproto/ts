import { createHash, randomBytes } from "node:crypto"
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { MemoryValidationError } from "./errors.js"
import { isInForce, memoryStatus } from "./lifecycle.js"
import { parseMemory, renderMemory } from "./markdown.js"
import { applyWriteScope, assertRetagOnly, isInNodeProjection } from "./node-scope.js"
import {
  MemoryConflictError,
  MemoryNotFoundError,
  MemorySlugTakenError,
  MemoryTransitionError,
  type MemoryFilter,
  type MemoryRecord,
  type MemoryScope,
  type MemorySearchHit,
  type MemorySearchOptions,
  type MemoryStore,
  type MemoryWriteOptions,
} from "./store.js"
import type { MemoryDocument, MemoryIssue, MemoryStatus } from "./types.js"
import { validateMemory } from "./validate.js"

/**
 * One hit of a knowledge provider, as much of the AIP-10
 * `KnowledgeHit` as the store reads.
 */
export interface MemoryKnowledgeHit {
  readonly sourceId: string
  readonly chunkId?: string
  readonly text: string
  readonly score: number
  /** `memoryId` (string) names the memory item the hit was indexed from. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * The slice of an AIP-10 `IKnowledgeProvider` (`@agentproto/knowledge-engine`)
 * the store delegates search to. Declared structurally so this package
 * takes no dependency on the knowledge engine: any `IKnowledgeProvider`
 * fits as is.
 */
export interface MemoryKnowledgeProvider {
  query(q: {
    readonly query: string
    readonly topK?: number
  }): Promise<{ readonly hits: readonly MemoryKnowledgeHit[] }>
}

export interface FilesMemoryStoreOptions {
  /** The store directory: `items/<type>/<id>.md` and `proposals/<id>.md` below it. */
  root: string
  /**
   * Optional search delegate. Its hits are merged with the built-in
   * keyword match: a hit naming an item of this store is checked against
   * the files (rule 22), anything else comes back as `source: "knowledge"`.
   */
  knowledge?: MemoryKnowledgeProvider
  /** The store's clock: `updated_at` on commits, and the in-force check. */
  now?: () => Date
  /**
   * The host declares AIP-34 trees (section 10, rule 33): a host call that
   * creates an item or a proposal with no node anchor is refused. Off: the
   * store behaves as sections 8 and 9 alone.
   */
  declaresTrees?: boolean
}

interface StoredItem {
  record: MemoryRecord
  path: string
  text: string
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const PROPOSAL_ID = /^[a-f0-9]{64}$/
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
const DEFAULT_SEARCH_LIMIT = 20
const SNIPPET_CHARS = 160

/**
 * AIP-72 section 8 reference store over a directory:
 *
 * ```
 * <root>/items/<type>/<id>.md      one memory/v1 item per file
 * <root>/proposals/<sha256>.md     pending proposals, not items
 * ```
 *
 * The files are the source of truth and the store keeps no index.
 * `revision` is the SHA-256 (hex) of the file bytes, a proposal id the
 * SHA-256 of the rendered proposal. Files are written to a temp file
 * then renamed into place. Item files are never deleted: a type change
 * renames the file, supersede and archive rewrite the `status` line
 * only. Mutations through one instance are serialized, so a
 * compare-and-set cannot interleave with another write of the same
 * store object; several processes writing one directory are not
 * coordinated.
 */
export class FilesMemoryStore implements MemoryStore {
  readonly #root: string
  readonly #knowledge: MemoryKnowledgeProvider | undefined
  readonly #now: () => Date
  readonly #declaresTrees: boolean
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: FilesMemoryStoreOptions) {
    this.#root = options.root
    this.#knowledge = options.knowledge
    this.#now = options.now ?? (() => new Date())
    this.#declaresTrees = options.declaresTrees ?? false
  }

  write(item: MemoryDocument, opts: MemoryWriteOptions): Promise<MemoryRecord> {
    return this.#exclusive(() =>
      opts.mode === "propose" ? this.#propose(item, opts) : this.#commit(item, opts),
    )
  }

  async read(id: string, opts: { scope?: MemoryScope } = {}): Promise<MemoryRecord | null> {
    const stored = await this.#find(id)
    // Rule 28: outside the projection reads as absent.
    return stored && visible(stored.record, opts.scope) ? stored.record : null
  }

  async list(filter: MemoryFilter = {}): Promise<readonly MemoryRecord[]> {
    const stored = filter.proposals ? await this.#allProposals() : await this.#allItems()
    const types = toArray(filter.type)
    const statuses = toArray(filter.status)
    // Section 8: in force by default when neither status nor inForce is
    // given. A proposal is never in force, so the default skips them.
    const inForce =
      filter.inForce ??
      (filter.status === undefined && !filter.proposals ? true : undefined)
    const now = this.#now()

    let records = stored
      .map((s) => s.record)
      .filter(({ item }) => {
        if (types && !types.includes(itemType(item) as never)) return false
        if (statuses && !statuses.includes(memoryStatus(item))) return false
        if (filter.slug !== undefined && item.slug !== filter.slug) return false
        if (filter.tags && !filter.tags.some((t) => item.tags?.includes(t))) return false
        // Rule 27, 29: the projection is applied here, before the slug
        // lookup below, and (for `search`) before ranking, snippets and limit.
        if (filter.scope && !isInNodeProjection(item, filter.scope)) return false
        if (inForce !== undefined) {
          const holds = !filter.proposals && isInForce(item, now)
          if (holds !== inForce) return false
        }
        return true
      })
      .sort(byNewest)

    // Rule 20: during an interrupted supersede two active items share a
    // slug; a lookup by slug returns the one with the later updated_at.
    if (filter.slug !== undefined && !filter.proposals) {
      const firstActive = records.find((r) => memoryStatus(r.item) === "active")
      records = records.filter(
        (r) => memoryStatus(r.item) !== "active" || r === firstActive,
      )
    }
    return records
  }

  async search(
    query: string,
    opts: MemorySearchOptions = {},
  ): Promise<readonly MemorySearchHit[]> {
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT
    const candidates = await this.list(opts.filter)
    const byId = new Map(candidates.map((r) => [r.item.id as string, r]))
    const hits = new Map<string, MemorySearchHit>()

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    for (const record of candidates) {
      const hit = keywordHit(record, terms)
      if (hit) hits.set(record.item.id as string, hit)
    }

    const foreign: MemorySearchHit[] = []
    // Rule 29: this store cannot restrict a provider's index to a projection,
    // so a scoped search is not delegated.
    if (this.#knowledge && !opts.filter?.scope) {
      const result = await this.#knowledge.query({ query, topK: limit })
      for (const kh of result.hits) {
        const named = kh.metadata?.memoryId
        const memoryId = typeof named === "string" ? named : kh.sourceId
        const record = byId.get(memoryId)
        if (record) {
          const prior = hits.get(memoryId)
          if (prior) prior.score = Math.max(prior.score ?? 0, kh.score)
          else hits.set(memoryId, memoryHit(record, kh.text || undefined, kh.score))
          continue
        }
        // Rule 22: an item of this store that the filter excludes (or no
        // longer in force) is dropped, never relabelled as knowledge.
        if (typeof named === "string" || (await this.read(memoryId))) continue
        const title = kh.metadata?.title
        foreign.push(
          compact({
            source: "knowledge" as const,
            title: typeof title === "string" && title ? title : kh.sourceId,
            snippet: kh.text ? clip(kh.text) : undefined,
            score: kh.score,
            ref: kh.chunkId ? `${kh.sourceId}#${kh.chunkId}` : kh.sourceId,
          }),
        )
      }
    }

    return [...hits.values(), ...foreign]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit)
  }

  supersede(
    oldId: string,
    next: MemoryDocument,
    opts: { ifRevision?: string; scope?: MemoryScope } = {},
  ): Promise<{ old: MemoryRecord; next: MemoryRecord }> {
    return this.#exclusive(async () => {
      const old = await this.#mustFind(oldId, opts.scope)
      checkRevision(oldId, opts.ifRevision, old.record.revision)
      const from = memoryStatus(old.record.item)
      if (from !== "active") throw new MemoryTransitionError(oldId, from, "superseded")
      if (next.id === oldId) {
        throw invalid("id", "the next item must have a new id (rule 20)")
      }
      // Rule 20: commit the new item first, then retire the old one.
      const committed = await this.#commit(
        next,
        { mode: "commit", ...(opts.scope ? { scope: opts.scope } : {}) },
        oldId,
        old.record.item,
      )
      const retired = await this.#rewriteStatus(old, "superseded")
      return { old: retired, next: committed }
    })
  }

  archive(id: string, opts: { ifRevision?: string; scope?: MemoryScope } = {}): Promise<MemoryRecord> {
    return this.#exclusive(async () => {
      const stored = await this.#mustFind(id, opts.scope)
      checkRevision(id, opts.ifRevision, stored.record.revision)
      const from = memoryStatus(stored.record.item)
      if (from === "archived") return stored.record
      if (from !== "active") throw new MemoryTransitionError(id, from, "archived")
      return this.#rewriteStatus(stored, "archived")
    })
  }

  dismiss(proposalId: string, opts: { scope?: MemoryScope } = {}): Promise<void> {
    return this.#exclusive(async () => {
      if (!PROPOSAL_ID.test(proposalId)) throw new MemoryNotFoundError("proposal", proposalId)
      if (opts.scope && !(await this.#proposalVisible(proposalId, opts.scope))) {
        throw new MemoryNotFoundError("proposal", proposalId)
      }
      try {
        await unlink(this.#proposalPath(proposalId))
      } catch (err) {
        if (isNotFound(err)) throw new MemoryNotFoundError("proposal", proposalId)
        throw err
      }
    })
  }

  async #propose(item: MemoryDocument, opts: MemoryWriteOptions): Promise<MemoryRecord> {
    const doc = clean(
      applyWriteScope(item, opts.scope, {
        ...(opts.owner ? { owner: opts.owner } : {}),
        declaresTrees: this.#declaresTrees,
      }),
    )
    const result = validateMemory(doc)
    if (!result.ok) {
      throw new MemoryValidationError("FilesMemoryStore.write (AIP-72 rule 13)", result.errors)
    }
    const text = renderMemory(doc)
    const proposalId = sha256(text)
    const path = this.#proposalPath(proposalId)
    const existing = await readText(path)
    if (existing === null) await atomicWrite(path, text)
    return { item: parseMemory(text), revision: proposalId, proposalId }
  }

  /**
   * The commit half of `write`, unlocked. `ignoreSlugOf` is the item being
   * superseded, `superseded` its document: the new item inherits its node
   * and ownership when it names none.
   */
  async #commit(
    item: MemoryDocument,
    opts: MemoryWriteOptions,
    ignoreSlugOf?: string,
    superseded?: MemoryDocument,
  ): Promise<MemoryRecord> {
    let doc = clean(item)
    if (opts.fromProposal !== undefined) {
      const known =
        PROPOSAL_ID.test(opts.fromProposal) &&
        (await readText(this.#proposalPath(opts.fromProposal))) !== null &&
        (!opts.scope || (await this.#proposalVisible(opts.fromProposal, opts.scope)))
      if (!known) throw new MemoryNotFoundError("proposal", opts.fromProposal)
    }
    if (doc.id !== undefined && !SAFE_ID.test(doc.id)) {
      throw invalid("id", "must be a file stem: [A-Za-z0-9] then [A-Za-z0-9_.-]")
    }

    const existing = doc.id === undefined ? null : await this.#find(doc.id)
    // Rules 27, 28: an item outside the projection cannot be changed, and
    // reads as absent.
    if (existing && !visible(existing.record, opts.scope)) {
      throw new MemoryNotFoundError("item", doc.id as string)
    }
    doc = clean(
      applyWriteScope(doc, opts.scope, {
        ...(opts.owner ? { owner: opts.owner } : {}),
        ...(existing || superseded ? { basis: (existing?.record.item ?? superseded) as MemoryDocument } : {}),
        declaresTrees: this.#declaresTrees && !existing,
      }),
    )
    if (existing && opts.scope) assertRetagOnly(existing.record.item, doc)
    const now = this.#now().toISOString()
    let next: MemoryDocument

    if (!existing) {
      if (opts.ifRevision !== undefined) {
        throw new MemoryConflictError(doc.id ?? "(new item)", opts.ifRevision, undefined)
      }
      const status = memoryStatus(doc)
      if (status !== "active") {
        throw new MemoryTransitionError(
          doc.id ?? "(new item)",
          "active",
          status,
          "a writer creates an item active (section 3)",
        )
      }
      next = { ...doc, id: doc.id ?? (await this.#newId()), updated_at: now }
      if (next.written !== undefined) next.written = now
      assertValid(next, true)
    } else {
      const current = existing.record
      const id = doc.id as string
      // Rule 18: equal but for updated_at / written is a no-op.
      if (sameContent(current.item, doc)) {
        await this.#dropProposal(opts.fromProposal)
        return current
      }
      checkRevision(id, opts.ifRevision, current.revision)
      const from = memoryStatus(current.item)
      const to = memoryStatus(doc)
      if (from !== to) {
        throw new MemoryTransitionError(
          id,
          from,
          to,
          from === "active" ? "retire an item through supersede or archive" : undefined,
        )
      }
      next = { ...doc, updated_at: now }
      if (next.written !== undefined || current.item.written !== undefined) next.written = now
      assertValid(next, false)
    }

    const id = next.id as string
    await this.#assertSlugFree(next, ignoreSlugOf)
    const path = this.#itemPath(itemType(next), id)
    if (existing && existing.path !== path) {
      // Rule 14: a type change moves the file; one file per id throughout.
      await mkdir(join(path, ".."), { recursive: true })
      await rename(existing.path, path)
    }
    const text = renderMemory(next)
    await atomicWrite(path, text)
    await this.#dropProposal(opts.fromProposal)
    return { item: withId(parseMemory(text), id), revision: sha256(text) }
  }

  /**
   * Supersede and archive are status-only rewrites (rules 6 and 19): the
   * `status` line is replaced, or added before the closing fence, and
   * every other byte stays as it was, whoever wrote the file.
   */
  async #rewriteStatus(stored: StoredItem, status: MemoryStatus): Promise<MemoryRecord> {
    const text = setStatusLine(stored.text, status)
    const item = withId(parseMemory(text), stored.record.item.id as string)
    if (item.status !== status) {
      throw new Error(`memory store (AIP-72): could not rewrite the status of '${item.id}'`)
    }
    await atomicWrite(stored.path, text)
    return { item, revision: sha256(text) }
  }

  async #assertSlugFree(next: MemoryDocument, ignore?: string): Promise<void> {
    if (next.slug === undefined || memoryStatus(next) !== "active") return
    for (const { record } of await this.#allItems()) {
      const other = record.item
      if (other.id === next.id || other.id === ignore) continue
      if (other.slug === next.slug && memoryStatus(other) === "active") {
        throw new MemorySlugTakenError(next.slug, other.id as string)
      }
    }
  }

  async #dropProposal(proposalId: string | undefined): Promise<void> {
    if (proposalId === undefined) return
    try {
      await unlink(this.#proposalPath(proposalId))
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }

  async #newId(): Promise<string> {
    for (;;) {
      const id = `mem_${Array.from(randomBytes(8), (b) => ID_ALPHABET[b % 36]).join("")}`
      if (!(await this.#find(id))) return id
    }
  }

  async #mustFind(id: string, scope?: MemoryScope): Promise<StoredItem> {
    const stored = await this.#find(id)
    if (!stored || !visible(stored.record, scope)) throw new MemoryNotFoundError("item", id)
    return stored
  }

  async #proposalVisible(proposalId: string, scope: MemoryScope): Promise<boolean> {
    const text = await readText(this.#proposalPath(proposalId))
    return text !== null && isInNodeProjection(parseMemory(text), scope)
  }

  async #find(id: string): Promise<StoredItem | null> {
    if (!SAFE_ID.test(id)) return null
    for (const dir of await listDir(join(this.#root, "items"))) {
      const path = join(this.#root, "items", dir, `${id}.md`)
      const text = await readText(path)
      if (text !== null) return { record: itemRecord(text, id), path, text }
    }
    return null
  }

  async #allItems(): Promise<StoredItem[]> {
    const out: StoredItem[] = []
    for (const dir of await listDir(join(this.#root, "items"))) {
      for (const file of await listDir(join(this.#root, "items", dir))) {
        if (!isMarkdown(file)) continue
        const path = join(this.#root, "items", dir, file)
        const text = await readText(path)
        if (text !== null) out.push({ record: itemRecord(text, file.slice(0, -3)), path, text })
      }
    }
    return out
  }

  async #allProposals(): Promise<StoredItem[]> {
    const out: StoredItem[] = []
    for (const file of await listDir(join(this.#root, "proposals"))) {
      if (!isMarkdown(file)) continue
      const path = join(this.#root, "proposals", file)
      const text = await readText(path)
      if (text === null) continue
      const proposalId = file.slice(0, -3)
      out.push({ record: { item: parseMemory(text), revision: sha256(text), proposalId }, path, text })
    }
    return out
  }

  #itemPath(type: string, id: string): string {
    return join(this.#root, "items", type, `${id}.md`)
  }

  #proposalPath(proposalId: string): string {
    return join(this.#root, "proposals", `${proposalId}.md`)
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn)
    this.#tail = run.catch(() => undefined)
    return run
  }
}

/** Rule 27: no scope is a host call, which sees everything. */
function visible(record: MemoryRecord, scope: MemoryScope | undefined): boolean {
  return scope === undefined || isInNodeProjection(record.item, scope)
}

function itemRecord(text: string, id: string): MemoryRecord {
  return { item: withId(parseMemory(text), id), revision: sha256(text) }
}

/** The path stem is the id (section 8 layout); fill it in when the file omits it. */
function withId(item: MemoryDocument, id: string): MemoryDocument {
  return item.id === undefined ? { ...item, id } : item
}

function itemType(item: MemoryDocument): string {
  return (item.type ?? item.kind) as string
}

function assertValid(doc: MemoryDocument, creating: boolean): void {
  // Rule 1: canonical fields on an item the store creates; a rewrite of a
  // legacy item may stay legacy (rule 9).
  const result = validateMemory(doc, { canonical: creating })
  if (!result.ok) {
    throw new MemoryValidationError("FilesMemoryStore.write (AIP-72 rule 13)", result.errors)
  }
}

function invalid(path: string, message: string): MemoryValidationError {
  const issue: MemoryIssue = { path, message, rule: "rule-13" }
  return new MemoryValidationError("FilesMemoryStore (AIP-72)", [issue])
}

function checkRevision(id: string, given: string | undefined, actual: string): void {
  if (given !== actual) throw new MemoryConflictError(id, given, actual)
}

/** Equal in every field but `updated_at` and `written`, body included (rule 18). */
function sameContent(a: MemoryDocument, b: MemoryDocument): boolean {
  const strip = (d: MemoryDocument) => {
    const { updated_at: _u, written: _w, ...rest } = d
    return stableJson({ ...rest, status: memoryStatus(d) })
  }
  return strip(a) === strip(b)
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  )
}

/** Drop `undefined` fields (rule 4: omitted, never written empty). */
function clean(item: MemoryDocument): MemoryDocument {
  return JSON.parse(JSON.stringify(item)) as MemoryDocument
}

function setStatusLine(text: string, status: MemoryStatus): string {
  const lines = text.split("\n")
  const open = lines[0]?.replace(/^﻿/, "").trimEnd()
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---")
  if (open !== "---" || close < 0) {
    throw new Error("memory store (AIP-72): item file has no frontmatter fence")
  }
  const cr = lines[close]!.endsWith("\r") ? "\r" : ""
  const line = `status: "${status}"`
  const at = lines.findIndex((l, i) => i > 0 && i < close && /^status[ \t]*:/.test(l))
  if (at >= 0) lines[at] = line + (lines[at]!.endsWith("\r") ? "\r" : "")
  else lines.splice(close, 0, line + cr)
  return lines.join("\n")
}

function keywordHit(record: MemoryRecord, terms: readonly string[]): MemorySearchHit | null {
  if (terms.length === 0) return null
  const { item } = record
  const title = [item.title, item.name, item.slug].filter(Boolean).join(" ").toLowerCase()
  const description = (item.description ?? "").toLowerCase()
  const body = item.body.toLowerCase()
  let points = 0
  for (const term of terms) {
    if (title.includes(term)) points += 3
    if (description.includes(term)) points += 2
    if (body.includes(term)) points += 1
  }
  if (points === 0) return null
  const snippetFrom = [item.body, item.description ?? ""].find((t) =>
    terms.some((term) => t.toLowerCase().includes(term)),
  )
  const snippet = snippetFrom ? around(snippetFrom, terms) : undefined
  // Normalized to (0, 1] so it ranks against a provider's scores.
  return memoryHit(record, snippet, points / (6 * terms.length))
}

function memoryHit(record: MemoryRecord, snippet: string | undefined, score: number): MemorySearchHit {
  const { item } = record
  return compact({
    source: "memory" as const,
    id: item.id as string,
    slug: item.slug,
    title: item.title ?? item.name ?? (item.id as string),
    snippet: snippet ?? (item.description || clip(item.body) || undefined),
    score,
  })
}

function around(text: string, terms: readonly string[]): string {
  const lower = text.toLowerCase()
  const at = Math.min(
    ...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0),
  )
  const start = Math.max(0, at - SNIPPET_CHARS / 4)
  return clip(text.slice(start))
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

function byNewest(a: MemoryRecord, b: MemoryRecord): number {
  const ta = a.item.updated_at ?? a.item.written ?? ""
  const tb = b.item.updated_at ?? b.item.written ?? ""
  if (ta !== tb) return ta < tb ? 1 : -1
  const ia = a.proposalId ?? a.item.id ?? ""
  const ib = b.proposalId ?? b.item.id ?? ""
  return ia < ib ? -1 : ia > ib ? 1 : 0
}

function toArray<T>(value: T | readonly T[] | undefined): readonly T[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? (value as readonly T[]) : [value as T]
}

function isMarkdown(file: string): boolean {
  return file.endsWith(".md") && !file.startsWith(".")
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const dir = join(path, "..")
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`)
  await writeFile(tmp, text, "utf8")
  try {
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort()
  } catch (err) {
    if (isNotFound(err)) return []
    throw err
  }
}

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}
