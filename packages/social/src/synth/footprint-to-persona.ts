/**
 * footprint-to-persona — pure mapper: distilled CHARACTER entries → an
 * AIP-25 PersonaDefinition shell (the TWIN projection).
 *
 * The persona is the voice + boundaries + backstory SHELL; the durable
 * knowledge (beliefs, patterns, lore) stays in the corpus entries, shipped
 * as a kb-persona pack that auto-mounts under the operator at recall. So
 * synth deliberately distils the shell, not the whole knowledge base —
 * the two compose at runtime via OverlayFs.
 *
 * Maps the distill kinds back (see distill/character.profile.ts):
 *   summary  → voice (signature phrases, tonality)
 *   critique → boundaries.refuses
 *   example  → backstory.background (lore)
 *   principle/pattern → stay in the KB (queried, not inlined)
 */

/** The subset of a distilled entry synth reads. */
export interface CharacterEntry {
  readonly kind: "summary" | "principle" | "pattern" | "critique" | "example"
  readonly title: string
  readonly body: string
  readonly tags?: readonly string[]
  readonly confidence?: number
}

export interface SynthSubject {
  readonly platform: string
  readonly handle: string
  readonly name?: string | null
  readonly bio?: string | null
}

/** Minimal AIP-25 shape we emit — assignable to PersonaDefinition. */
export interface SynthesizedPersona {
  schema: "persona/v1"
  name: string
  title: string
  description: string
  version: string
  backstory?: {
    oneLineHook?: string
    background?: string
    archetypes?: string[]
    era?: string
    setting?: string
  }
  voice?: {
    register?: string
    signaturePhrases?: string[]
    tonality?: string[]
  }
  boundaries?: {
    refuses?: string[]
  }
  tags?: string[]
  metadata?: Record<string, unknown>
}

/**
 * Pull verbatim quoted segments from a body. Double quotes are taken as-is
 * (deliberate quotes). Single quotes only count when the opening quote sits at
 * a word boundary AND the close is followed by a terminator — otherwise English
 * contractions ("Roman's … don't") get captured as one bogus phrase.
 */
function quotedPhrases(body: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  const dq = /["“]([^"”\n]{3,120})["”]/g
  while ((m = dq.exec(body))) out.push(m[1]!.trim())
  const sq = /(?<=^|[\s(\[—–])['‘]([^'’\n]{3,120})['’](?=[\s.,;:!?)\]…]|$)/g
  while ((m = sq.exec(body))) out.push(m[1]!.trim())
  // Drop fragments with a leftover unbalanced quote at either edge.
  return out.filter((p) => p.length > 0 && !/^["'`]|["'`]$/.test(p))
}

/** Strip a leading "Voice:"/"Voice -" label so the title reads as a descriptor. */
function voiceDescriptor(title: string): string {
  return title.replace(/^voice\s*[:\-–—]\s*/i, "").trim()
}

function dedupe(xs: string[], limit: number): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))].slice(0, limit)
}

export interface SynthOptions {
  readonly version?: string
  /** Override the generated machine name (default `char-<handle>`). */
  readonly name?: string
}

/**
 * Synthesize a PersonaDefinition shell from character entries. Deterministic
 * + pure — given the same entries it yields the same persona.
 */
export function entriesToPersona(
  entries: readonly CharacterEntry[],
  subject: SynthSubject,
  opts: SynthOptions = {}
): SynthesizedPersona {
  const handle = subject.handle
  const summaries = entries.filter((e) => e.kind === "summary")
  const critiques = entries.filter((e) => e.kind === "critique")
  const examples = entries.filter((e) => e.kind === "example")

  const signaturePhrases = dedupe(
    summaries.flatMap((e) => quotedPhrases(e.body)),
    24
  )
  // Tonality = the voice-summary descriptors themselves (their titles), not
  // corpus tag slugs — the distiller writes these as "Terse, list-heavy …".
  const tonality = dedupe(
    summaries.map((e) => voiceDescriptor(e.title)),
    8
  )
  const refuses = dedupe(
    critiques.map((e) => e.title),
    12
  )
  const background = examples
    .slice(0, 8)
    .map((e) => `- ${e.title}: ${e.body}`)
    .join("\n")

  const display = (subject.name && subject.name.trim()) || `@${handle}`

  const persona: SynthesizedPersona = {
    schema: "persona/v1",
    name: opts.name ?? `char-${handle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    title: display,
    description:
      (subject.bio && subject.bio.trim()) ||
      `Character synthesized from @${handle}'s ${subject.platform} footprint.`,
    version: opts.version ?? "0.1.0",
    backstory: {
      oneLineHook: `@${handle} — ${subject.bio?.trim() || "captured from their social footprint"}`,
      ...(background ? { background } : {}),
      // archetypes intentionally omitted: corpus tags aren't character
      // archetypes. The real signal lives in the KB pattern/principle entries
      // (queried at recall); a distiller-emitted archetype is the proper source.
      era: "contemporary",
      setting: "real-world",
    },
    voice: {
      ...(signaturePhrases.length ? { signaturePhrases } : {}),
      ...(tonality.length ? { tonality } : {}),
    },
    ...(refuses.length ? { boundaries: { refuses } } : {}),
    tags: ["character", subject.platform, handle.toLowerCase()],
    metadata: {
      social: {
        platform: subject.platform,
        handle,
        entryCount: entries.length,
        derivedFrom: "social-footprint",
      },
    },
  }
  return persona
}
