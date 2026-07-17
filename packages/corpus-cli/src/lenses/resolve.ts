/**
 * Lens resolution for the `corpus distill --lens` flag.
 *
 * A lens can be reached three ways, in priority order:
 *   1. `--lens <id>` → a workspace-declared `lenses/<id>.md` (overrides a
 *      built-in of the same id), else a {@link BUILTIN_LENSES built-in}.
 *   2. `--lens-file <path>` → an ad-hoc lens declaration file, resolved by path
 *      (the escape hatch; same `.md` format as a workspace lens).
 *
 * A lens declaration is a markdown file: frontmatter carries `id` / `label` /
 * `aspect` / `kinds` / `mode`, and the markdown BODY is the extraction prompt
 * (a long prompt reads far better as prose than as a YAML block scalar). The
 * `prompt` frontmatter key is accepted as a fallback when the body is empty.
 * This mirrors how sources and entries are authored in this corpus system, and
 * is the file-based analog of the guild's `guild.settings.knowledgeLenses`.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import matter from "gray-matter"
import { z } from "zod"
import { isRefinedKind, type Lens, type LensMode, type RefinedKind } from "@agentproto/corpus"
import { BUILTIN_LENSES, builtinLensIds } from "./builtin.js"

/** Thrown when a `--lens` / `--lens-file` cannot be resolved into a valid Lens. */
export class LensError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LensError"
  }
}

/** Lenient view of a lens declaration's frontmatter (each field degrades safely). */
const LENS_FRONTMATTER = z
  .object({
    id: z.string().optional().catch(undefined),
    label: z.string().optional().catch(undefined),
    aspect: z.string().optional().catch(undefined),
    prompt: z.string().optional().catch(undefined),
    mode: z.string().optional().catch(undefined),
    kinds: z.array(z.string()).optional().catch(undefined),
    synthesisPath: z.string().optional().catch(undefined),
  })
  .loose()

/**
 * Parse a lens declaration file's contents into a {@link Lens}. `fallbackId` is
 * used when the frontmatter omits `id` (the workspace filename slug / `--lens`
 * value). Throws {@link LensError} when no prompt can be found.
 */
export function parseLensDoc(raw: string, fallbackId: string): Lens {
  const parsed = matter(raw)
  const fm = LENS_FRONTMATTER.parse(parsed.data)
  const prompt = (parsed.content.trim() || fm.prompt?.trim()) ?? ""
  if (!prompt) {
    throw new LensError(
      `lens "${fm.id ?? fallbackId}" has no prompt — put the extraction instruction in the markdown body or a "prompt:" frontmatter key.`
    )
  }
  const kinds: RefinedKind[] = (fm.kinds ?? []).filter(isRefinedKind)
  const mode: LensMode = fm.mode === "synthesis" ? "synthesis" : "log"
  return {
    id: fm.id ?? fallbackId,
    label: fm.label ?? fm.id ?? fallbackId,
    prompt,
    mode,
    ...(fm.aspect ? { aspect: fm.aspect } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(fm.synthesisPath ? { synthesisPath: fm.synthesisPath } : {}),
  }
}

/**
 * Resolve `--lens <id>`: a workspace `lenses/<id>.md` (override) wins over a
 * built-in of the same id. Throws {@link LensError} listing the built-ins when
 * neither exists.
 */
export async function resolveLens(id: string, workspaceRoot: string): Promise<Lens> {
  const wsPath = join(workspaceRoot, "lenses", `${id}.md`)
  if (existsSync(wsPath)) {
    return parseLensDoc(await readFile(wsPath, "utf8"), id)
  }
  const builtin = BUILTIN_LENSES[id]
  if (builtin) return builtin
  throw new LensError(
    `unknown lens "${id}". Built-in: ${builtinLensIds().join(", ") || "(none)"}. ` +
      `Declare one at ${join("lenses", `${id}.md`)} in the workspace, or pass --lens-file <path>.`
  )
}

/** Resolve `--lens-file <path>`: parse an ad-hoc lens declaration by path. */
export async function resolveLensFile(path: string): Promise<Lens> {
  if (!existsSync(path)) {
    throw new LensError(`--lens-file not found: ${path}`)
  }
  const fallbackId = basename(path).replace(/\.[^.]+$/, "")
  return parseLensDoc(await readFile(path, "utf8"), fallbackId)
}
