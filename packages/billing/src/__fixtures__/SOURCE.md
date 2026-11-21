# Fixtures

`examples/*.BILLING.md` and `BILLING.schema.json` are copies of the files of the
AIP-BILLING draft (pull request agentproto/agentproto#170, branch `aip-74-billing`),
at commit `e449783d3ef80a3b80f33c84ddc29965f83b8508`.

They are test data. The schema is a draft: when the draft moves, these files move
with it, in the same change as the parser.

`AIP-BILLING` is a placeholder for the draft's AIP number: `scripts/check-aip-refs.mjs`
fails on any `AIP-<N>` that the pinned canonical registry does not know, and the pin
predates the #170 merge. Rename the placeholder to the real number in the same change
that bumps `specs/canonical.lock.json` past that merge (same pattern as `AIP-VOICE`
on the voice kit).
