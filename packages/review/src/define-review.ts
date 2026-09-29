import { createDoctype } from "@agentproto/define-doctype"
import {
  buildReviewManifest,
  checkReviewFrontmatter,
  ReviewManifestError,
  type ReviewDefinition,
  type ReviewManifest,
} from "./manifest.js"

/** The immutable result of {@link defineReview}: the normalized manifest
 *  (every default applied, cross-field rules checked) minus the markdown
 *  `body`, which a TS-authored definition doesn't have. */
export type ReviewHandle = Readonly<Omit<ReviewManifest, "body">>

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

function rethrow(e: unknown): never {
  if (e instanceof ReviewManifestError) throw new Error(`defineReview (AIP-62): ${e.detail}`)
  throw e
}

/**
 * AIP-62 reference implementation of `defineReview`.
 *
 * Field-level shape runs the zod schema generated from `REVIEW.schema.json`
 * — the same `checkReviewFrontmatter` `parseReviewManifest` uses — and the
 * cross-field rules run the same `buildReviewManifest`, so a malformed
 * definition fails with the same diagnostic as a malformed REVIEW.md. The
 * schema check runs while the identity is read so that its diagnostic (not a
 * generic id one) is what the caller sees first.
 */
export const defineReview = createDoctype<ReviewDefinition, ReviewHandle>({
  aip: 62,
  name: "review",
  idPattern: /^[a-z][a-z0-9-]*$/,
  readDescription: false,
  readIdentity(def) {
    try {
      return checkReviewFrontmatter(def).id
    } catch (e) {
      return rethrow(e)
    }
  },
  validate(def) {
    try {
      buildReviewManifest(checkReviewFrontmatter(def), "")
    } catch (e) {
      rethrow(e)
    }
  },
  build(def) {
    const { body: _body, ...handle } = buildReviewManifest(checkReviewFrontmatter(def), "")
    return deepFreeze(handle)
  },
})
