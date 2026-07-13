/**
 * lintReportConfig — catch mis-named ReportConfig keys before they vanish.
 *
 * `reportConfigSchema` is `.passthrough()` everywhere (intentional — render/
 * presentation fields the engine doesn't read must survive a parse
 * round-trip). The side effect: a typo'd field (`chapters[].brief` instead
 * of `chapters[].cover`) parses fine and silently never reaches the engine.
 * This walks the raw config against the schema shape and flags what
 * `.passthrough()` would otherwise eat quietly.
 */

import { reportChapterSchema, reportConfigSchema } from "./types.js"

const TOP_LEVEL_KEYS = new Set(Object.keys(reportConfigSchema.shape))
const CHAPTER_KEYS = new Set(Object.keys(reportChapterSchema.shape))

/** Common typos with an unambiguous correct key. */
const ALIASES: Record<string, string> = {
  brief: "cover",
  claimCap: "cap",
  keywords: "kw",
  maxClaims: "cap",
}

/** Known presentation passthroughs — legal, just not read by the engine. */
const INFORMATIONAL = new Set(["subtitle", "writer", "citationStyle", "render"])

function lintKeys(
  obj: Readonly<Record<string, unknown>>,
  known: ReadonlySet<string>,
  where: string
): string[] {
  const out: string[] = []
  for (const key of Object.keys(obj)) {
    if (known.has(key)) continue
    const alias = ALIASES[key]
    if (alias) {
      out.push(`WARN  ${where}.${key} — unknown key, did you mean "${alias}"?`)
    } else if (INFORMATIONAL.has(key)) {
      out.push(`INFO  ${where}.${key} — not read by the engine (informational)`)
    } else {
      out.push(`WARN  ${where}.${key} — unknown key (not read by the engine)`)
    }
  }
  return out
}

/**
 * Lint a raw (pre- or post-parse — `.passthrough()` preserves extra keys
 * either way) report config for mis-named or dead keys. Returns one message
 * per flagged key, prefixed `WARN`/`INFO`; empty when the config is clean.
 * Parsing behavior is unchanged — this is diagnostics only.
 */
export function lintReportConfig(config: unknown): string[] {
  if (typeof config !== "object" || config === null) return []
  const top = config as Record<string, unknown>
  const messages = lintKeys(top, TOP_LEVEL_KEYS, "config")

  const chapters = top.chapters
  if (Array.isArray(chapters)) {
    chapters.forEach((chapter, i) => {
      if (typeof chapter !== "object" || chapter === null) return
      const id = (chapter as Record<string, unknown>).id
      const where = `chapters[${i}]${typeof id === "string" ? ` (${id})` : ""}`
      messages.push(
        ...lintKeys(chapter as Record<string, unknown>, CHAPTER_KEYS, where)
      )
    })
  }

  return messages
}
