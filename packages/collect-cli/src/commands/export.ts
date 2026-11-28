import { createWriteStream } from "node:fs"
import { resolve } from "node:path"
import { once } from "node:events"
import type { CollectItem } from "@agentproto/collect"
import { type ExitCode, type Io, UsageError, err, outJson } from "../io"
import { parse, positional } from "../args"
import { storePathOf } from "../load"
import { open } from "./shared"

/** CSV columns. Structured fields are JSON text in their cell, so nothing is lost. */
export const CSV_COLUMNS = [
  "id", "source", "sourceInstance", "kind", "url", "canonicalUrl", "contentId", "contentGroupId", "title", "text",
  "textTruncated", "language", "wordCount", "format", "authorRef", "submitterRef", "publishedAt", "postedAt", "firstSeenAt",
  "hasMedia", "query", "runId", "subjects", "tags", "links", "outboundLinks", "parts", "rawRefs", "ext",
] as const

function cell(value: unknown): string {
  if (value === undefined || value === null) return ""
  const text = typeof value === "object" ? JSON.stringify(value) : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function csvRow(item: CollectItem): string {
  const r = item as Record<string, unknown>
  return CSV_COLUMNS.map((c) => cell(r[c])).join(",")
}

export async function runExport(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, {
    store: { type: "string" },
    format: { type: "string" },
    source: { type: "string" },
    out: { type: "string" },
    view: { type: "string" },
  })
  positional(positionals, "none", 0)
  if (values.view !== undefined) {
    if (values.view === "flat") {
      err(io, "collect: --view flat is not available yet")
      return 2
    }
    throw new UsageError(`unknown view "${values.view}"`)
  }
  const format = values.format ?? "jsonl"
  if (format !== "jsonl" && format !== "csv") throw new UsageError(`--format must be jsonl or csv, got "${format}"`)
  const store = await open(storePathOf(io, values.store))

  const file = values.out ? createWriteStream(resolve(io.cwd, values.out)) : undefined
  const write = async (text: string) => {
    if (!file) return void io.stdout.write(text)
    if (!file.write(text)) await once(file, "drain")
  }
  let count = 0
  const items = store.items(values.source)
  try {
    if (format === "csv") await write(`${CSV_COLUMNS.join(",")}\n`)
    for await (const item of items) {
      await write(`${format === "csv" ? csvRow(item) : JSON.stringify(item)}\n`)
      count++
    }
  } finally {
    if (file) {
      file.end()
      await once(file, "close")
    }
  }
  if (items.skipped > 0) err(io, `warning: ${items.skipped} unreadable line(s) skipped`)
  if (file && values.json) outJson(io, { out: resolve(io.cwd, values.out!), format, items: count })
  else if (file) err(io, `${count} item(s) written to ${values.out}`)
  return 0
}
