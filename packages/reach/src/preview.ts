/**
 * The one convention parser: an approval `preview` (whatever the requester
 * wrote) turned into REACH content.
 *
 * - `summary` is `preview.summary` when it is a non-empty string, else the
 *   record title the host passes in.
 * - `sections` keeps the entries with a string `title` and `text`.
 * - `links` keeps the entries with a string `label` and an `https:` url.
 * - `attachments` keeps bare file names (a string, or `{ name }`): a name with
 *   a path separator, `.` or `..` is dropped.
 * - Every other key (the legacy preview shapes) is dropped: it stays on the
 *   record for the approval page.
 */

import type { ReachAttachment, ReachContent, ReachLink, ReachSection } from "./types.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return false
  }
}

/** A bare file name: no separator, not `.` or `..`, not empty. */
export function isBareFileName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed !== "" && trimmed !== "." && trimmed !== ".." && !/[/\\]/.test(trimmed) && !trimmed.includes("\0")
}

export function reachContentFromPreview(preview: unknown, fallbackSummary: string): ReachContent {
  const p = isRecord(preview) ? preview : {}
  const summary = typeof p.summary === "string" && p.summary.trim() !== "" ? p.summary : fallbackSummary

  const sections: ReachSection[] = []
  if (Array.isArray(p.sections)) {
    for (const item of p.sections) {
      if (isRecord(item) && typeof item.title === "string" && typeof item.text === "string") {
        sections.push({ title: item.title, text: item.text })
      }
    }
  }

  const links: ReachLink[] = []
  if (Array.isArray(p.links)) {
    for (const item of p.links) {
      if (isRecord(item) && typeof item.label === "string" && typeof item.url === "string" && isHttps(item.url)) {
        links.push({ label: item.label, url: item.url })
      }
    }
  }

  const attachments: ReachAttachment[] = []
  if (Array.isArray(p.attachments)) {
    for (const item of p.attachments) {
      const name = typeof item === "string" ? item : isRecord(item) && typeof item.name === "string" ? item.name : undefined
      if (name !== undefined && isBareFileName(name) && !attachments.some(a => a.name === name)) {
        attachments.push({ name })
      }
    }
  }

  return {
    summary,
    ...(sections.length > 0 ? { sections } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}
