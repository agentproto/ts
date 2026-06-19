/**
 * synthesizeLens — the `mode:"synthesis"` half of the Lens contract.
 *
 * Where a `log` lens just accumulates atoms (the diary), a `synthesis` lens
 * rolls the CURRENT atoms of its aspect into one consolidated, living artifact —
 * rebuilt whenever a new decision lands. "Marketing knowledge" is the canonical
 * case: a new decision can REVERSE a prior one, so the consolidated view must be
 * re-derived from the current (non-superseded) atom set, not just appended to.
 *
 * "Current" = entries tagged `aspect:<lens>` that are NOT superseded by another
 * entry and are NOT the prior synthesis artifact itself (`role:synthesis`). The
 * artifact is pure derived state: an AIP-10 entry at `synthesisPath`, rewritten
 * each run, queryable + graph-projected like any other entry (open-Q2 lean from
 * KNOWLEDGE-LENS-DESIGN.md). Excluding `role:synthesis` from the atom read keeps
 * the rebuild from feeding on its own output.
 *
 * Pure: consumes FsPort + ClockPort + an injected SynthesisPort (the LLM that
 * consolidates). The model boundary mirrors {@link DistillPort}.
 */

import matter from "gray-matter"
import { z } from "zod"
import type { FsPort } from "../ports/fs.port.js"
import type { ClockPort } from "../ports/clock.port.js"
import { lensAspect, lensAspectTag, type Lens } from "./lens.js"

/** Tag marking the consolidated artifact so the rebuild never reads it as an atom. */
export const SYNTHESIS_ROLE_TAG = "role:synthesis" as const

/** One current atom handed to the synthesizer. */
export interface SynthesisAtom {
  readonly slug: string
  readonly title: string
  readonly body: string
}

export interface SynthesisInput {
  readonly aspect: string
  readonly label: string
  /** The current (non-superseded) atoms of the aspect, highest-confidence first. */
  readonly atoms: readonly SynthesisAtom[]
}

/**
 * The LLM boundary for synthesis — given the current atoms of an aspect, return
 * the consolidated artifact body (markdown). Host-supplied, so the kit stays
 * model-free (same discipline as {@link DistillPort}).
 */
export interface SynthesisPort {
  synthesize(input: SynthesisInput): Promise<string>
}

export interface SynthesizeLensOptions {
  readonly fs: FsPort
  readonly clock: ClockPort
  readonly synthesizer: SynthesisPort
  readonly lens: Lens
}

export interface SynthesizeLensReport {
  readonly lensId: string
  readonly aspect: string
  /** Entries tagged with the aspect (before the superseded/role filter). */
  readonly atomsConsidered: number
  /** Atoms that fed the synthesis (current view). */
  readonly atomsUsed: number
  /** Whether an artifact was (re)written — false when there are no current atoms. */
  readonly wrote: boolean
  /** Workspace-relative path of the artifact, when written. */
  readonly path?: string
}

/** Lenient frontmatter view — only what synthesis needs (cast-free, degrades). */
const ATOM_FRONTMATTER = z
  .object({
    schema: z.string().optional().catch(undefined),
    slug: z.string().optional().catch(undefined),
    title: z.string().optional().catch(undefined),
    sources: z.array(z.string()).optional().catch(undefined),
    confidence: z.number().optional().catch(undefined),
    tags: z.array(z.string()).optional().catch(undefined),
    supersedes: z.array(z.string()).optional().catch(undefined),
    metadata: z
      .object({
        corpus: z
          .object({ status: z.string().optional().catch(undefined) })
          .loose()
          .optional()
          .catch(undefined),
      })
      .loose()
      .optional()
      .catch(undefined),
  })
  .loose()

interface ReadEntry {
  readonly slug: string
  readonly title: string
  readonly body: string
  readonly confidence: number
  readonly tags: readonly string[]
  readonly supersedes: readonly string[]
  readonly path: string
  readonly archived: boolean
  readonly isSynthesis: boolean
}

/** Walk `entries/`, parse the frontmatter synthesis cares about. */
async function readEntries(fs: FsPort): Promise<readonly ReadEntry[]> {
  let rels: readonly string[]
  try {
    rels = await fs.walk("entries")
  } catch {
    return []
  }
  const out: ReadEntry[] = []
  for (const rel of rels) {
    if (!rel.endsWith(".md")) continue
    const path = `entries/${rel}`
    let parsed
    try {
      parsed = matter(await fs.readFile(path))
    } catch {
      continue
    }
    const fm = ATOM_FRONTMATTER.parse(parsed.data)
    if (fm.schema !== "knowledge.entry/v1") continue
    const tags = fm.tags ?? []
    out.push({
      slug: fm.slug ?? path,
      title: fm.title ?? "",
      body: parsed.content.trim(),
      confidence: fm.confidence ?? 0,
      tags,
      supersedes: fm.supersedes ?? [],
      path,
      archived: fm.metadata?.corpus?.status === "archived",
      isSynthesis: tags.includes(SYNTHESIS_ROLE_TAG),
    })
  }
  return out
}

/**
 * The current atoms of a lens's aspect: tagged `aspect:<lens>`, not archived,
 * not the synthesis artifact, and not superseded by any other entry. Sorted
 * highest-confidence first (the order handed to the synthesizer).
 */
export async function currentLensAtoms(
  fs: FsPort,
  lens: Lens
): Promise<readonly SynthesisAtom[]> {
  const aspectTag = lensAspectTag(lens)
  const entries = await readEntries(fs)
  // A slug is superseded if ANY entry (of any aspect) lists it in `supersedes:`.
  const superseded = new Set<string>()
  for (const e of entries) for (const s of e.supersedes) superseded.add(s)

  return entries
    .filter(
      e =>
        !e.archived &&
        !e.isSynthesis &&
        e.tags.includes(aspectTag) &&
        !superseded.has(e.slug)
    )
    .sort((a, b) => b.confidence - a.confidence)
    .map(e => ({ slug: e.slug, title: e.title, body: e.body }))
}

/** Default artifact location for a lens with no explicit `synthesisPath`. */
export function defaultSynthesisPath(lens: Lens): string {
  return `entries/summaries/${lensAspect(lens)}-knowledge.md`
}

export interface LensStaleness {
  /** True when the artifact does not reflect the current atom set. */
  readonly stale: boolean
  /** "missing" (no artifact yet) | "drifted" (atom set changed) | "fresh". */
  readonly reason: "missing" | "drifted" | "fresh"
  /** Current (non-superseded) atom count. */
  readonly atomCount: number
}

/**
 * Whether a synthesis lens's artifact is stale — timestamp-free, deterministic:
 * the artifact records the atom slugs it consolidated in its `sources:`. If the
 * CURRENT atom set differs (a new decision added/superseded an atom), the
 * artifact has drifted and should be rebuilt. No artifact yet ⇒ stale when
 * atoms exist. This is the "mark-stale-on-new-atom" surface (P4).
 */
export async function lensSynthesisStale(
  fs: FsPort,
  lens: Lens
): Promise<LensStaleness> {
  const atoms = await currentLensAtoms(fs, lens)
  const atomSlugs = new Set(atoms.map(a => a.slug))
  const path = lens.synthesisPath ?? defaultSynthesisPath(lens)

  if (!(await fs.exists(path))) {
    return { stale: atoms.length > 0, reason: atoms.length > 0 ? "missing" : "fresh", atomCount: atoms.length }
  }
  let recorded: readonly string[] = []
  try {
    const fm = ATOM_FRONTMATTER.parse(matter(await fs.readFile(path)).data)
    recorded = fm.sources ?? []
  } catch {
    return { stale: true, reason: "drifted", atomCount: atoms.length }
  }
  const recordedSet = new Set(recorded)
  const same =
    recordedSet.size === atomSlugs.size &&
    [...atomSlugs].every(s => recordedSet.has(s))
  return {
    stale: !same,
    reason: same ? "fresh" : "drifted",
    atomCount: atoms.length,
  }
}

/**
 * Re-derive a synthesis lens's consolidated artifact from its current atoms and
 * write it (overwrite — derived state) as an AIP-10 entry tagged with the aspect
 * and `role:synthesis`. No-op (wrote:false) when the lens has no current atoms.
 */
export async function synthesizeLens(
  opts: SynthesizeLensOptions
): Promise<SynthesizeLensReport> {
  const { fs, clock, synthesizer, lens } = opts
  const aspect = lensAspect(lens)

  const entries = await readEntries(fs)
  const aspectTag = lensAspectTag(lens)
  const considered = entries.filter(
    e => !e.archived && !e.isSynthesis && e.tags.includes(aspectTag)
  ).length

  const atoms = await currentLensAtoms(fs, lens)
  if (atoms.length === 0) {
    return { lensId: lens.id, aspect, atomsConsidered: considered, atomsUsed: 0, wrote: false }
  }

  const body = await synthesizer.synthesize({ aspect, label: lens.label, atoms })
  const path = lens.synthesisPath ?? defaultSynthesisPath(lens)
  await fs.writeFile(path, serializeSynthesis(body, lens, atoms, clock))

  return {
    lensId: lens.id,
    aspect,
    atomsConsidered: considered,
    atomsUsed: atoms.length,
    wrote: true,
    path,
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function serializeSynthesis(
  body: string,
  lens: Lens,
  atoms: readonly SynthesisAtom[],
  clock: ClockPort
): string {
  const now = clock.now().toISOString()
  const slug = `${lensAspect(lens)}-knowledge`
  const fm: Record<string, unknown> = {
    schema: "knowledge.entry/v1",
    slug,
    kind: "summary",
    title: `${lens.label} — current view`,
    updated_at: now,
    // Provenance: the atoms this synthesis consolidates (derivedFrom edges).
    sources: atoms.map(a => a.slug),
    confidence: 0.8,
    // Faceted aspect tag + the synthesis role marker (kept verbatim — both are
    // AIP-10 facet structure, not plain tags, so they bypass the topic sanitizer).
    tags: [lensAspectTag(lens), SYNTHESIS_ROLE_TAG],
    metadata: {
      corpus: {
        status: "active",
        promotionMode: "lens-synthesis",
        promotedAt: now,
        lens: lens.id,
      },
    },
  }
  const trimmed = body.trim()
  return matter.stringify(trimmed.startsWith("\n") ? trimmed : "\n" + trimmed, fm)
}

/** Build the synthesis prompt — the model-agnostic core (mirrors buildDistillPrompt). */
export function buildSynthesisPrompt(input: SynthesisInput): string {
  const atomBlock = input.atoms
    .map((a, i) => `### Atom ${i + 1}: ${a.title}\n${a.body}`)
    .join("\n\n")
  return `You consolidate the CURRENT knowledge of one aspect into a single living document for an AI operator. You are given the current (non-superseded) atoms — each a durable insight already extracted. Earlier reversed decisions have already been removed, so treat every atom as currently true.

ASPECT: ${input.aspect} (${input.label})

Write a coherent, well-structured markdown document that:
- Synthesizes the atoms into a unified current view — not a list, a narrative the operator can act on.
- Resolves overlaps; group related atoms under headings.
- States the CURRENT position plainly. Do not hedge with "previously" / "it was decided" — this is the present truth.
- Stays grounded ONLY in the atoms; invent nothing.
- Writes in ENGLISH.

CURRENT ATOMS:
${atomBlock}

Return ONLY the markdown document body (no frontmatter, no code fence).`
}
