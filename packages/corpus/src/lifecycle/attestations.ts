/**
 * Attestation helpers — append + read the per-transition audit chain
 * stored under `metadata.corpus.attestations[]`.
 *
 * Pure. The lifecycle workflows (promote, playbook activate/archive,
 * playbook evaluator) call `appendAttestation` immediately before
 * writing the file. Tooling that displays the chain (curator UI,
 * `corpus events:trace <slug>`) calls `readAttestations`.
 */

import type { Attestation } from "../types.js"

/**
 * Append an attestation to a frontmatter object's
 * `metadata.corpus.attestations[]`. Returns a NEW frontmatter
 * object — mutation-free so callers can chain transformations.
 *
 * If `metadata.corpus.attestations` doesn't exist, it's created. If
 * the new attestation is byte-identical to the last entry (same kind
 * + identity + at), it's a no-op (idempotent against
 * lifecycle workflow retries).
 */
export function appendAttestation(
  frontmatter: Readonly<Record<string, unknown>>,
  attestation: Attestation
): Record<string, unknown> {
  const metaIn = (frontmatter.metadata as Record<string, unknown> | undefined) ?? {}
  const corpusIn =
    (metaIn.corpus as Record<string, unknown> | undefined) ?? {}
  const existing =
    (corpusIn.attestations as Attestation[] | undefined) ?? []
  const last = existing[existing.length - 1]
  if (
    last &&
    last.kind === attestation.kind &&
    last.identity === attestation.identity &&
    last.at === attestation.at
  ) {
    // Idempotent — don't duplicate on lifecycle retry.
    return { ...frontmatter }
  }
  return {
    ...frontmatter,
    metadata: {
      ...metaIn,
      corpus: {
        ...corpusIn,
        attestations: [...existing, attestation],
      },
    },
  }
}

/**
 * Read the attestation chain off a frontmatter object. Returns `[]`
 * if the entry has none (e.g. legacy entries written before the
 * attestation chain shipped).
 */
export function readAttestations(
  frontmatter: Readonly<Record<string, unknown>>
): readonly Attestation[] {
  const meta = frontmatter.metadata as { corpus?: { attestations?: unknown } } | undefined
  const list = meta?.corpus?.attestations
  if (!Array.isArray(list)) return []
  return Object.freeze(list as Attestation[])
}

/**
 * Convenience: build an attestation from current clock + identity.
 * Lifecycle code typically calls this then immediately
 * `appendAttestation`.
 */
export function makeAttestation(input: {
  readonly kind: Attestation["kind"]
  readonly identity: string
  readonly at: string
  readonly model?: string
  readonly promptHash?: string
  readonly note?: string
}): Attestation {
  return Object.freeze({
    kind: input.kind,
    identity: input.identity,
    at: input.at,
    ...(input.model ? { model: input.model } : {}),
    ...(input.promptHash ? { promptHash: input.promptHash } : {}),
    ...(input.note ? { note: input.note } : {}),
  })
}
