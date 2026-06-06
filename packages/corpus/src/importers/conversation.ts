/**
 * ConversationImporter — turns conversations into corpus sources by rendering
 * each to a transcript through an injected ConversationSourcePort. The importer
 * is pure: it slugs, hashes, and shapes ImportedSource; the port supplies the
 * environment-bound "ref → turns" capability (a Mastra thread store, a chat DB).
 *
 * This is the seam for conversation→knowledge distill — the resulting sources
 * feed DistillRunner exactly like web sources do (the pipeline is provenance-
 * agnostic). Chat is append-only, so a single immutable slug per conversation
 * would collide once new turns arrive; the host handles this by WINDOWING —
 * giving each ConversationDoc a window-unique id (e.g. `<thread>-<date>`), so
 * each window distills once and a daily run only sees fresh windows.
 *
 * Config (target.config):
 *   - refs: string[]                              — required. Refs to resolve.
 *   - tags?: string[]                             — applied to every source.
 *   - language?: string                           — fallback BCP-47.
 *   - authority?: "primary"|"secondary"|"rumour"  — default "secondary".
 *   - maxRefs?: number                            — defaults to 1000.
 *
 * Pure kit code — consumes ConversationSourcePort, no chat-store dependency.
 * Slug: derived from the doc id. Hash: sha256 of the rendered transcript, so
 * an unchanged window re-import dedups in ImporterRunner.
 */

import { createHash } from "node:crypto"
import { slugify, uniqueSlug } from "../util/slug.js"
import { normalizeLanguageTag } from "../util/language.js"
import type {
  ConversationDoc,
  ConversationSourcePort,
  ConversationTurn,
} from "../ports/conversation-source.port.js"
import type {
  CorpusImporter,
  ImportedSource,
  ImporterTarget,
} from "./types.js"

type Authority = "primary" | "secondary" | "rumour"

export interface ConversationImporterOptions {
  readonly source: ConversationSourcePort
}

interface ConversationConfig {
  readonly refs: readonly string[]
  readonly tags?: readonly string[]
  readonly language?: string
  readonly authority?: Authority
  readonly maxRefs?: number
}

export class ConversationImporter implements CorpusImporter {
  readonly id = "conversation"
  readonly label = "Conversation"

  constructor(private readonly opts: ConversationImporterOptions) {}

  async *enumerate(target: ImporterTarget): AsyncIterable<ImportedSource> {
    const config = parseConfig(target.config)
    const maxRefs = config.maxRefs ?? 1000
    const seenSlugs = new Set<string>()
    let yielded = 0

    for (const ref of config.refs) {
      if (yielded >= maxRefs) break

      // A port signals "couldn't resolve this ref" with null. A *thrown* error
      // (store unreachable, auth) must NOT abort the whole batch — the throw
      // would propagate out of this generator and kill every remaining ref.
      // Treat it as a per-ref skip; the importer is resumable, so a re-run
      // retries it.
      let doc: ConversationDoc | null
      try {
        doc = await this.opts.source.fetchConversation(ref)
      } catch {
        continue
      }
      if (!doc || doc.turns.length === 0) continue

      const body = renderTranscript(doc.turns)
      if (!body) continue // every turn was empty — nothing to distill

      const slug = uniqueSlug(
        slugify(doc.id, { fallback: "" }) ||
          slugify(doc.title ?? "conversation", { fallback: "conversation" }),
        seenSlugs
      )
      const language = normalizeLanguageTag(doc.language ?? config.language)
      const stamps = doc.turns
        .map(t => t.at)
        .filter((a): a is string => typeof a === "string" && a.length > 0)
        .sort()

      yield {
        slug,
        title: (doc.title ?? `Conversation ${doc.id}`).slice(0, 200),
        contentHash: sha256(body),
        body,
        authority: config.authority ?? "secondary",
        ...(language ? { language } : {}),
        ...(config.tags && config.tags.length > 0 ? { tags: config.tags } : {}),
        corpusMetadata: {
          conversationRef: ref,
          conversationId: doc.id,
          sourceKind: "conversation",
          turnCount: countTurns(doc.turns),
          ...(stamps.length
            ? { firstTurnAt: stamps[0], lastTurnAt: stamps[stamps.length - 1] }
            : {}),
        },
      }
      yielded++
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseConfig(
  raw: Readonly<Record<string, unknown>>
): ConversationConfig {
  const rawRefs = raw.refs
  if (!Array.isArray(rawRefs) || rawRefs.length === 0) {
    throw new Error(
      "ConversationImporter: config.refs is required (non-empty string[])"
    )
  }
  const refs = rawRefs.filter(
    (x): x is string => typeof x === "string" && x.length > 0
  )
  if (refs.length === 0) {
    throw new Error(
      "ConversationImporter: config.refs contained no usable strings"
    )
  }
  const rawTags = raw.tags
  return {
    refs,
    maxRefs: typeof raw.maxRefs === "number" ? raw.maxRefs : undefined,
    tags: Array.isArray(rawTags)
      ? rawTags.filter((x): x is string => typeof x === "string")
      : undefined,
    language: typeof raw.language === "string" ? raw.language : undefined,
    authority: isAuthority(raw.authority) ? raw.authority : undefined,
  }
}

function isAuthority(v: unknown): v is Authority {
  return v === "primary" || v === "secondary" || v === "rumour"
}

/** Render turns to a plain transcript — `Role: text`, blank-line separated.
 *  Empty-text turns are dropped so the distiller sees only substance. */
function renderTranscript(turns: readonly ConversationTurn[]): string {
  const blocks: string[] = []
  for (const turn of turns) {
    const text = turn.text.trim()
    if (!text) continue
    blocks.push(`${labelRole(turn.role)}: ${text}`)
  }
  return blocks.join("\n\n")
}

function countTurns(turns: readonly ConversationTurn[]): number {
  let n = 0
  for (const t of turns) if (t.text.trim()) n++
  return n
}

function labelRole(role: string): string {
  const r = role.trim()
  if (!r) return "Speaker"
  return r.charAt(0).toUpperCase() + r.slice(1)
}

function sha256(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex")
}
