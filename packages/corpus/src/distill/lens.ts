/**
 * Lens — a named projection over the shared source pool.
 *
 * Sources are captured once (conversations / files / web → immutable `sources/`).
 * A Lens decides *what to extract from them* and *how that extraction lives over
 * time*. The same material read under two lenses produces two independent entry
 * sets (a "diary" lens and a "marketing" lens over the same conversations), each
 * tagged with its `aspect:` facet and ledgered independently by `(source, lens)`.
 *
 * A Lens is the {@link DistillDescriptor} pattern generalized: descriptors vary
 * the *source* (guild-sources vs guild-web); a Lens varies the *projection* over
 * a shared source set. Registering a lens is the whole of "add an aspect".
 *
 * Two modes — the heart of the design:
 *   - `log`       extraction, append-only. The atoms ARE the artifact; never
 *                 rebuilt. A conversation diary, a changelog, a research journal.
 *   - `synthesis` re-derived living artifact. Atoms are supersedes-aware, and a
 *                 consolidated doc at `synthesisPath` is rolled up from the
 *                 current (non-superseded) atoms — rebuilt when a new decision
 *                 lands. Marketing knowledge, a positioning doc.
 *
 * Pure data: no behavior. The distill core reads a Lens to set the instruction,
 * constrain kinds, and stamp the `aspect:` tag; synthesis (P2) reads `mode` +
 * `synthesisPath` to drive the report engine.
 *
 * Design: projects/guilde/docs/KNOWLEDGE-LENS-DESIGN.md
 */

import type { RefinedKind } from "./types.js"

/** How a lens's extraction lives over time. See module doc. */
export type LensMode = "log" | "synthesis"

/**
 * Which sources feed a lens. P1 ships the universal `"all"`; richer selection
 * (by tag / channel / provenance prefix) lands with the per-guild setting in P3.
 */
export type SourceSelector =
  | { readonly kind: "all" }
  | { readonly kind: "tag"; readonly tag: string }
  | { readonly kind: "prefix"; readonly prefix: string }

/** A named, time-aware projection over the shared source pool. */
export interface Lens {
  /** Stable id, e.g. "marketing" | "diary" | "sales". Also the ledger lens key. */
  readonly id: string
  /** Human label. */
  readonly label: string
  /**
   * Extraction instruction handed to the distiller — "what to look for under
   * this aspect". Prepended to the base distill prompt (see {@link DistillInput}).
   */
  readonly prompt: string
  /**
   * Faceted aspect value. Stamped on every entry this lens produces as the tag
   * `aspect:<aspect>` (a graph-knowledge facet → the query key for the lens).
   * Defaults to {@link Lens.id} when omitted at construction (see {@link lensAspect}).
   */
  readonly aspect?: string
  /** Which RefinedKinds the lens may emit (orthogonal to aspect). */
  readonly kinds?: readonly RefinedKind[]
  /** How the lens lives over time. */
  readonly mode: LensMode
  /** Which sources feed it. Defaults to `{ kind: "all" }`. */
  readonly sourceSelector?: SourceSelector
  /** For `mode:"synthesis"` — where the consolidated artifact is (re)written. */
  readonly synthesisPath?: string
}

/** The aspect value for a lens — explicit `aspect`, else the lens id. */
export function lensAspect(lens: Lens): string {
  return lens.aspect ?? lens.id
}

/** The faceted tag stamped on a lens's entries: `aspect:<value>`. */
export function lensAspectTag(lens: Lens): string {
  return `aspect:${lensAspect(lens)}`
}
