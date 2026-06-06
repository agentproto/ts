/**
 * footprint-to-corpus — pure mapper: FootprintRecord[] → ImportedSource[].
 *
 * Only the subject's OWN words become corpus sources — their posts,
 * threads, quotes, and the reply-text they wrote on others' posts. That
 * is the voice signal the character distiller reads. Engagement-received
 * and connections are network signal; they go to the graph sink, not here.
 *
 * One immutable source per voice unit (AIP-10 sources are immutable):
 * slug derives from the post urn so the same post always maps to the same
 * source — the ImporterRunner then dedups by content_hash, giving free
 * resume + incremental capture. (Distill economy is a distill-time
 * concern — the character distiller reads many sources per call rather
 * than forcing coarse storage batches here.)
 */

import { createHash } from "node:crypto"
import { slugify, uniqueSlug, isSourceSlug } from "@agentproto/corpus"
import type { ImportedSource } from "@agentproto/corpus"
import type {
  FootprintRecord,
  PostRecord,
  PostRef,
  MediaRef,
  EngagementGivenRecord,
} from "../model/footprint.js"
import { isVoiceRecord } from "../model/footprint.js"

export interface FootprintToCorpusOptions {
  /** Subject handle — used for slug prefix + source tags. */
  readonly handle: string
  /** Subject profile URL, attached as the source's originalUrl. */
  readonly profileUrl?: string | null
  /** Extra tags applied to every source (e.g. a capture run tag). */
  readonly tags?: readonly string[]
}

function sha256(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex")
}

/** Last id segment of an urn (`x:1789` → `1789`), for stable slugs. */
function urnId(urn: string): string {
  const i = urn.lastIndexOf(":")
  return i >= 0 ? urn.slice(i + 1) : urn
}

/** Render attached media as a markdown block (images inline, video/gif linked). */
function renderMedia(media?: readonly MediaRef[]): string {
  if (!media || media.length === 0) return ""
  const lines = media.map((m) => {
    // Prefer the archived local path (durable) over the rot-prone CDN URL.
    const ref = m.stored?.key ?? m.url
    if (m.type === "image") return `![${m.alt ?? "image"}](${ref})`
    const secs = m.durationMs ? ` (${Math.round(m.durationMs / 1000)}s)` : ""
    const alt = m.alt ? ` — ${m.alt}` : ""
    return `[${m.type}${secs}${alt}](${ref})`
  })
  return `\n\n${lines.join("\n")}`
}

/** Render the quoted post inline so a quote-tweet is self-contained. */
function renderQuoted(q: PostRef): string {
  const who = q.authorHandle ? `@${q.authorHandle}` : "post"
  const text = (q.text ?? "").replace(/\s+/g, " ").slice(0, 280)
  const link = q.url ? ` <${q.url}>` : ""
  return `\n\n> **Quoting ${who}:** ${text}${link}${renderMedia(q.media)}`
}

function renderPost(r: PostRecord): { title: string; body: string } {
  const meta: string[] = []
  if (r.createdAt) meta.push(r.createdAt)
  if (r.numLikes != null) meta.push(`${r.numLikes} likes`)
  if (r.numComments != null) meta.push(`${r.numComments} replies`)
  if (r.numReposts != null) meta.push(`${r.numReposts} reposts`)
  const label =
    r.subtype === "reply"
      ? `Reply${r.replyToHandle ? ` to @${r.replyToHandle}` : ""}`
      : r.subtype === "quote"
        ? "Quote"
        : r.subtype === "thread"
          ? "Thread"
          : "Post"
  const header = `## ${label}${meta.length ? ` — ${meta.join(" · ")}` : ""}`
  const link = r.url ? `\n\n<${r.url}>` : ""
  const quoted = r.quoted ? renderQuoted(r.quoted) : ""
  return {
    title: `${label}: ${(r.text ?? "").replace(/\s+/g, " ").slice(0, 80)}`,
    body: `${header}\n\n${r.text ?? ""}${quoted}${renderMedia(r.media)}${link}\n`,
  }
}

function renderReply(r: EngagementGivenRecord): { title: string; body: string } {
  const to = r.target.authorHandle ? ` to @${r.target.authorHandle}` : ""
  const quoted = r.target.text
    ? `\n\n> ${r.target.text.replace(/\s+/g, " ").slice(0, 280)}`
    : ""
  const link = r.target.url ? `\n\n<${r.target.url}>` : ""
  const targetMedia = renderMedia(r.target.media)
  return {
    title: `Reply${to}: ${(r.replyText ?? "").replace(/\s+/g, " ").slice(0, 80)}`,
    body: `## Reply${to}${quoted}${targetMedia}\n\n${r.replyText ?? ""}${link}\n`,
  }
}

/** Map voice records to immutable AIP-10 sources (one per unit). */
export function footprintToSources(
  records: readonly FootprintRecord[],
  opts: FootprintToCorpusOptions
): ImportedSource[] {
  const seen = new Set<string>()
  const sources: ImportedSource[] = []
  const baseTags = ["social", ...(opts.tags ?? [])]

  for (const r of records) {
    if (!isVoiceRecord(r)) continue

    let platform: string
    let urn: string
    let subtype: string
    let rendered: { title: string; body: string }

    if (r.kind === "post") {
      platform = r.platform
      urn = r.urn
      subtype = r.subtype
      rendered = renderPost(r)
    } else {
      platform = r.platform
      urn = `${r.target.urn}:re`
      subtype = "reply"
      rendered = renderReply(r)
    }

    const slug = uniqueSlug(
      slugify(`${platform} ${subtype} ${urnId(urn)}`, { fallback: "source" }),
      seen
    )
    if (!isSourceSlug(slug)) continue

    sources.push({
      slug,
      title: rendered.title || slug,
      contentHash: sha256(rendered.body),
      body: rendered.body,
      originalUrl: r.kind === "post" ? (r.url ?? opts.profileUrl ?? undefined) : (r.target.url ?? undefined),
      // Their own words about themselves — primary source authority.
      authority: "primary",
      tags: [...baseTags, platform, opts.handle, subtype],
      corpusMetadata: {
        platform,
        handle: opts.handle,
        slice: "authored",
        recordKind: r.kind,
        subtype,
        urn,
      },
    })
  }
  return sources
}
