/**
 * AIP-70 spec-name registry values for AIP-7 GOVERNANCE.
 *
 * `SPEC_NAME` is the canonical name from the specs repo's names registry
 * (`specs/names.json`, AIP-70 GLOSSARY). `LEGACY_SPEC_NAMES` lists the
 * names earlier drafts of this package used; every read or validation
 * path accepts `SPEC_NAME` plus all legacy names so existing signed
 * artifacts and audit chains keep verifying.
 *
 * `EMITTED_SPEC_NAME` is the tag this package keeps WRITING into new
 * signatures, audit rows, and policy handles for now: verifiers in the
 * field only know the pre-AIP-70 tag, and the tag is part of the hashed
 * bytes of every audit row. The emitted value flips to `SPEC_NAME` at
 * the next major release.
 */

/** Canonical AIP-70 registry name. */
export const SPEC_NAME = "governance/v1" as const

/** Pre-AIP-70 names still accepted when reading or validating artifacts. */
export const LEGACY_SPEC_NAMES = ["agentgovernance/v1"] as const

/**
 * Tag written into newly produced artifacts and handles for now. Old
 * verifiers in the field only know this pre-AIP-70 tag; the emitted
 * value flips to SPEC_NAME at the next major.
 */
export const EMITTED_SPEC_NAME = "agentgovernance/v1" as const

/** Every schema tag accepted on the read/validate paths. */
export const ACCEPTED_SPEC_NAMES = [SPEC_NAME, ...LEGACY_SPEC_NAMES] as const
