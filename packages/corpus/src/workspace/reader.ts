/**
 * CorpusWorkspaceReader — scan + parse a corpus workspace via FsPort.
 *
 * Pure path-discipline + YAML parsing — no schema validation here. The
 * reader's job is to surface every .md file in the workspace and
 * classify it by location. Schema validation happens in
 * `validate/validator.ts` so callers can run both in parallel and get
 * crisp error categorization.
 *
 * Pure: no `node:fs`, no `node:path`. All paths are joined manually
 * with "/" so the kit runs on Node, Bun, Deno, and browser-side
 * editors (e.g. curator UI lint preview).
 */

import matter from "gray-matter"
import { createHash } from "node:crypto"
import type { FsPort } from "../ports/fs.port.js"
import type {
  CorpusWorkspaceSnapshot,
  FileKind,
  ParsedFile,
} from "../types.js"

export interface CorpusWorkspaceReaderOptions {
  readonly fs: FsPort
}

export class CorpusWorkspaceReader {
  constructor(private readonly opts: CorpusWorkspaceReaderOptions) {}

  /**
   * Scan the workspace rooted at `root` and return a typed snapshot.
   * `root` is workspace-relative (the host resolves to a backing
   * storage); commonly "" for the workspace root itself.
   */
  async read(root: string): Promise<CorpusWorkspaceSnapshot> {
    const files = await this.opts.fs.walk(root)
    const mdFiles = files.filter((p) => p.endsWith(".md"))

    const buckets: Record<FileKind, ParsedFile[]> = {
      "knowledge-workspace": [],
      "knowledge-source": [],
      "knowledge-entry": [],
      "collection-schema": [],
      "collection-item": [],
      "playbook": [],
      "operator": [],
      "workflow": [],
      "routine": [],
      "unknown": [],
    }

    for (const path of mdFiles) {
      const content = await this.opts.fs.readFile(path)
      const parsed = matter(content)
      const file: ParsedFile = {
        path,
        kind: classify(path, root),
        frontmatter: (parsed.data ?? {}) as Readonly<Record<string, unknown>>,
        body: parsed.content,
        versionToken: sha256(content),
      }
      buckets[file.kind].push(file)
    }

    return {
      root,
      workspace: buckets["knowledge-workspace"][0] ?? null,
      sources: freeze(buckets["knowledge-source"]),
      entries: freeze(buckets["knowledge-entry"]),
      collections: freeze(buckets["collection-schema"]),
      collectionItems: freeze(buckets["collection-item"]),
      playbooks: freeze(buckets["playbook"]),
      operators: freeze(buckets["operator"]),
      workflows: freeze(buckets["workflow"]),
      routines: freeze(buckets["routine"]),
      unknown: freeze(buckets["unknown"]),
    }
  }
}

// ── Classification ─────────────────────────────────────────────────────

/**
 * Classify a workspace-relative path by AIP convention.
 *
 * Important: the reader does NOT consult frontmatter to decide. Location
 * is authoritative — a file at `entries/principles/foo.md` is always
 * "knowledge-entry" even if its frontmatter is wrong. The validator
 * later surfaces the mismatch as a structured error.
 */
function classify(path: string, root: string): FileKind {
  const rel = stripRoot(path, root)
  const segs = rel.split("/").filter(Boolean)
  const fname = segs[segs.length - 1] ?? ""

  if (segs.length === 1 && fname === "KNOWLEDGE.md") return "knowledge-workspace"

  const top = segs[0]
  switch (top) {
    case "sources":
      return "knowledge-source"
    case "entries":
      return "knowledge-entry"
    case "collections":
      if (fname === "COLLECTION.md") return "collection-schema"
      if (fname === "ITEM.md" || /^[a-z0-9][a-z0-9-]*\.md$/.test(fname))
        return "collection-item"
      return "unknown"
    case "playbooks":
      if (fname === "PLAYBOOK.md") return "playbook"
      return "unknown"
    case "operators":
      if (fname === "OPERATOR.md") return "operator"
      return "unknown"
    case "workflows":
      if (fname === "WORKFLOW.md") return "workflow"
      return "unknown"
    case "routines":
      if (fname === "ROUTINE.md") return "routine"
      return "unknown"
    default:
      return "unknown"
  }
}

function stripRoot(path: string, root: string): string {
  if (!root) return path
  const prefix = root.endsWith("/") ? root : root + "/"
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function sha256(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex")
}

function freeze<T>(arr: T[]): readonly T[] {
  return Object.freeze([...arr])
}
