/**
 * Built-in lens catalog — lenses that ship with the `corpus` CLI and resolve by
 * id in ANY workspace, no declaration required (`corpus distill <ws> --lens craft`).
 *
 * A {@link Lens} is a named projection over the source pool: its `prompt` is
 * threaded to the distiller as the extraction instruction, its `kinds` constrain
 * the emitted kinds, and its `aspect` is stamped on every produced entry as the
 * `aspect:<value>` facet tag (the query key). See
 * `@agentproto/corpus` `distill/lens.ts` + projects/guilde/docs/KNOWLEDGE-LENS-DESIGN.md.
 *
 * This is the CLI-side analog of the guild's built-in catalog
 * (`apps/api` `services/knowledge-generate/lenses.ts`): a workspace can override
 * any of these — or add its own — by dropping a `lenses/<id>.md` declaration in
 * the workspace root (see {@link resolveLens}).
 */

import type { Lens } from "@agentproto/corpus"

/**
 * `craft` — extract TRANSFERABLE WRITING-CRAFT MOVES: how a piece is written
 * (hook, structure, depth, voice, rhythm, ending), not what it is about. A `log`
 * lens — craft moves accumulate across sources; there is no consolidated artifact
 * to re-derive. Prompt validated in the studio (`/tmp/craft-lens.txt`), adapted
 * to the distiller's `{kind,title,body,confidence,tags}` item shape.
 */
export const CRAFT_LENS: Lens = {
  id: "craft",
  label: "Writing craft",
  aspect: "craft",
  mode: "log",
  // The distiller emits {kind,title,body,...}; a craft move is a technique
  // (pattern), a rule (principle), a shallow default it avoids (critique), or a
  // specific instance (example). "summary" is dropped — a summary is topic
  // content, not a transferable craft move.
  kinds: ["pattern", "principle", "critique", "example"],
  prompt: [
    "Extract TRANSFERABLE WRITING-CRAFT MOVES from the source — reusable techniques a writer could apply to ANY topic. Study HOW the piece is written; IGNORE what it is about. Do NOT extract facts, claims, or lessons about the subject matter — only the craft.",
    "",
    "Focus on: how the first line hooks; structure and transitions; how depth is manufactured (specificity, tension, the earned turn, surprising-but-true facts); how voice and edge are earned without cringe; sentence rhythm and variation; how it ends. Prioritise the moves that separate memorable writing from generic filler.",
    "",
    "For each move:",
    '- kind: "pattern" for a technique, "principle" for a rule, "critique" for a shallow/generic default the move avoids, "example" for a specific instance.',
    '- title: name the move crisply and imperatively (e.g. "Delay the thesis until after a concrete image").',
    "- body: state the reusable technique in 1-2 topic-agnostic sentences; name the generic / AI-default it beats; and include a <=30-word verbatim snippet from the source where the move happens (omit the quote only when the move is purely structural).",
  ].join("\n"),
}

/** Every built-in lens, keyed by id. */
export const BUILTIN_LENSES: Readonly<Record<string, Lens>> = {
  [CRAFT_LENS.id]: CRAFT_LENS,
}

/** The ids of every built-in lens — for `--lens` error messages. */
export function builtinLensIds(): readonly string[] {
  return Object.keys(BUILTIN_LENSES)
}
