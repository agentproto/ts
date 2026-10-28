import { parseDocument, stringify } from "yaml"
import { MemoryParseError, MemoryValidationError } from "./errors.js"
import type { MemoryDocument } from "./types.js"
import { validateMemory } from "./validate.js"

const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

/**
 * Split a MEMORY.md file into its frontmatter fields and `body`.
 *
 * The frontmatter is read as YAML 1.2 core schema, so a date-time stays
 * a string and an unquoted `true`, `null` or `2026` in a string field
 * reaches `validateMemory` as a non-string and fails there (rule 3).
 * This only parses: it does not validate, so a reader can still load an
 * item it will then inspect. The body is free (rule 12): one blank line
 * after the closing fence is the separator, everything after it is kept
 * byte for byte.
 */
export function parseMemory(markdown: string): MemoryDocument {
  const text = markdown.startsWith("﻿") ? markdown.slice(1) : markdown
  const match = FRONTMATTER_RE.exec(text)
  if (!match) {
    throw new MemoryParseError("missing frontmatter: the file must open with a '---' fence")
  }
  const yamlDoc = parseDocument(match[1] ?? "", { version: "1.2", schema: "core" })
  if (yamlDoc.errors.length > 0) {
    throw new MemoryParseError(
      `invalid YAML frontmatter: ${yamlDoc.errors.map((e) => e.message).join("; ")}`,
    )
  }
  const data: unknown = yamlDoc.toJS()
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new MemoryParseError("frontmatter must be a YAML mapping")
  }
  if ("body" in data) {
    throw new MemoryParseError("'body' is the markdown after the fence, not a frontmatter key")
  }
  let body = text.slice(match[0].length)
  if (body.startsWith("\r\n")) body = body.slice(2)
  else if (body.startsWith("\n")) body = body.slice(1)
  return { ...(data as Omit<MemoryDocument, "body">), body }
}

/**
 * Render a memory/v1 document as MEMORY.md. Throws a
 * `MemoryValidationError` if the document does not validate.
 *
 * Every string value is double-quoted, so a YAML 1.1 or 1.2 reader
 * reads it back as a string (rule 3); undefined fields are omitted
 * (rule 4); key order is the document's own. So re-rendering a file this
 * function wrote, with only `status` changed, changes only the `status`
 * line (rule 6). That does not hold for a file another writer produced
 * (unquoted strings, other key styles, comments): re-rendering it
 * normalizes every line, which is why the store rewrites the status line
 * in place instead (`setStatusLine`, `files-store.ts`).
 * `parseMemory(renderMemory(d))` deep-equals `d`.
 */
export function renderMemory(doc: MemoryDocument): string {
  const result = validateMemory(doc)
  if (!result.ok) {
    throw new MemoryValidationError("renderMemory (AIP-72)", result.errors)
  }
  const { body, ...frontmatter } = doc
  const yamlText = stringify(frontmatter, {
    version: "1.2",
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
    lineWidth: 0,
  })
  return `---\n${yamlText}---\n${body ? `\n${body}` : ""}`
}
