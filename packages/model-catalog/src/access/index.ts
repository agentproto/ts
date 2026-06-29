/**
 * Access subpath — workspace-aware allow/block evaluation over the
 * unified catalog.
 */
export { evaluateAccess } from "./evaluate.js"
export type { AccessEvalInput, AccessDecision } from "./evaluate.js"
export { evaluateCatalogDefaults } from "./catalog-defaults.js"
export type { CatalogDefaultDecision } from "./catalog-defaults.js"
export type {
  AccessEffect,
  AccessTarget,
  AccessRule,
  AppScope,
} from "./types.js"
