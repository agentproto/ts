/**
 * The Stripe API version this adapter reads. Every field it uses was checked
 * against the types of the SDK that pins this version (a test compares the
 * two). Configure the webhook endpoint at this version: an event of another
 * version is refused with an exception, since its objects may not have the
 * shape read here (invoice payments, for one, moved in `2025-03-31.basil`).
 */
export const STRIPE_API_VERSION = "2026-11-18.endive" as const
