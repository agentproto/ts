# Skill: ponytail-review (over-engineering pass)

Vendored from the open-source `ponytail` skill (DietrichGebert/ponytail, MIT) —
think like the laziest senior dev in the room: the best code is the code you
never wrote. Run this lens *in addition to* correctness review.

## Scope
Over-engineering and needless complexity **only**. Correctness bugs, security,
and performance are out of scope for this lens (the main review covers them).

## Find what to delete
- **reinvented stdlib** — hand-rolled code that a built-in already does
  (`Array.prototype`, `Object`, `structuredClone`, `URL`, `Intl`, …).
- **unneeded dependency** — a package pulled in for one trivial function.
- **speculative abstraction** — interfaces/generics/config hooks with a single
  caller and no second use in sight (YAGNI).
- **dead flexibility** — options, parameters, branches that nothing exercises.
- **shrinkable** — multi-step code that collapses to a clear one-liner.

## Output (fold into the review under a "Simplify" heading)
For each item, one line:
`L<line>: <tag> <what>. <replacement>.`
where `<tag>` ∈ `delete: | stdlib: | native: | yagni: | shrink:`.
End with: `net: -<N> lines possible.`

## Discipline
- Only flag what is genuinely removable without losing required behavior.
- If nothing is over-engineered, say so in one line — do not invent cuts.
- This lens never blocks a PR on its own; it advises.
