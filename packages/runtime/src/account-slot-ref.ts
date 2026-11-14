/**
 * Import-free constants for account slot refs (`slot:<name>`), shared by the
 * config schema and `account-slots.ts`. Kept in their own module so the schema
 * can import them without a cycle through `config.ts`.
 */

/** Prefix that marks a `profileRef` as a slot reference. */
export const SLOT_REF_PREFIX = "slot:"

/** A valid slot name: letters, digits, `_` and `-`. No dot (config paths are
 *  dotted), no colon (a slot cannot name another slot). */
export const ACCOUNT_SLOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
