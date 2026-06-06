/**
 * Restriction lattice — the LAW layer.
 *
 * A `Restriction` is the set of tags a value carries (e.g. "image-only",
 * "promo", "non-withdrawable"). Restrictions form a join-semilattice under
 * **union**: the `meet` of two restrictions is the union of their tags —
 * restrictions ACCUMULATE, they never cancel. This is what makes laundering
 * self-defeating: converting value can only ADD restrictions (move up the
 * lattice), never strip them.
 *
 * Canonical form is a sorted, deduped string array so restrictions compare by
 * value and serialize deterministically (a `Set` would not).
 */

/** A single restriction marker that propagates through conversions. */
export type RestrictionTag = string

/** Canonical (sorted, deduped) set of restriction tags. */
export type Restriction = readonly RestrictionTag[]

/** Bottom of the lattice — carries no restriction, spendable/convertible freely. */
export const UNRESTRICTED: Restriction = Object.freeze([])

/** Sort + dedupe an arbitrary tag iterable into canonical form. */
export function canonical(tags: Iterable<RestrictionTag>): Restriction {
  const seen = new Set<RestrictionTag>()
  for (const t of tags) if (t.length > 0) seen.add(t)
  return Object.freeze([...seen].sort())
}

/**
 * Meet (greatest lower bound) = union of tags. Restrictions accumulate, so the
 * meet is MORE restricted than either operand. Associative, commutative,
 * idempotent → a valid semilattice operation.
 */
export function meet(a: Restriction, b: Restriction): Restriction {
  return canonical([...a, ...b])
}

/**
 * `a ⊑ b` — `a` is LESS-OR-EQUALLY restricted than `b`, i.e. a's tags are a
 * subset of b's. Value at `a` may legally flow to anything requiring at most
 * `b`'s restrictions; the reverse is forbidden.
 */
export function lessRestrictedOrEqual(a: Restriction, b: Restriction): boolean {
  const set = new Set(b)
  return a.every(t => set.has(t))
}

/** Value equality on canonical restrictions. */
export function equalRestriction(a: Restriction, b: Restriction): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i])
}

/** Count of restriction tags — used by coalescing's restricted-first ordering. */
export function restrictionWeight(r: Restriction): number {
  return r.length
}

export interface LatticeCheckResult {
  ok: boolean
  violations: string[]
}

/**
 * Verify the semilattice axioms over a sample of restrictions. Run in CI as a
 * gate: any violation means the meet is mis-implemented and the no-arbitrage /
 * non-laundering guarantees no longer hold structurally.
 */
export function verifyLattice(sample: readonly Restriction[]): LatticeCheckResult {
  const violations: string[] = []
  const s = sample.map(canonical)

  for (const a of s) {
    // idempotent: a ∧ a = a
    if (!equalRestriction(meet(a, a), a)) {
      violations.push(`idempotency: meet(a,a) ≠ a for [${a.join(",")}]`)
    }
    for (const b of s) {
      // commutative: a ∧ b = b ∧ a
      if (!equalRestriction(meet(a, b), meet(b, a))) {
        violations.push(`commutativity: meet(a,b) ≠ meet(b,a) for [${a}] [${b}]`)
      }
      // meet is an upper bound on restriction: a ⊑ (a ∧ b)
      if (!lessRestrictedOrEqual(a, meet(a, b))) {
        violations.push(`monotonicity: a ⋢ meet(a,b) for [${a}] [${b}]`)
      }
      for (const c of s) {
        // associative: (a ∧ b) ∧ c = a ∧ (b ∧ c)
        if (!equalRestriction(meet(meet(a, b), c), meet(a, meet(b, c)))) {
          violations.push(`associativity for [${a}] [${b}] [${c}]`)
        }
      }
    }
  }
  return { ok: violations.length === 0, violations }
}
