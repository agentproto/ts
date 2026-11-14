/**
 * AIP-70 spec-name registry values for AIP-7 GOVERNANCE.
 *
 * `SPEC_NAME` is the canonical name from the specs repo's names registry
 * (`specs/names.json`, AIP-70 GLOSSARY). `LEGACY_SPEC_NAMES` lists the
 * names earlier drafts of this package used; every read or validation
 * path accepts `SPEC_NAME` plus all legacy names so existing signed
 * artifacts and audit chains keep verifying.
 *
 * `EMITTED_SPEC_NAME` is the tag this package WRITES into new signatures,
 * audit rows, and policy handles. It is the canonical AIP-70 name; readers
 * keep accepting the pre-AIP-70 legacy tag.
 */

/** Canonical AIP-70 registry name. */
export const SPEC_NAME = "governance/v1" as const

/** Pre-AIP-70 names still accepted when reading or validating artifacts. */
export const LEGACY_SPEC_NAMES = ["agentgovernance/v1"] as const

/** Canonical tag written into newly produced artifacts and handles. */
export const EMITTED_SPEC_NAME = SPEC_NAME

/** Every schema tag accepted on the read/validate paths. */
export const ACCEPTED_SPEC_NAMES = [SPEC_NAME, ...LEGACY_SPEC_NAMES] as const
