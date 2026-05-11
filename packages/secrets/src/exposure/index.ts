/**
 * @agentproto/secrets/exposure — runtime surface descriptors for
 * AIP-19 secrets + the `$$SECRET[NAME]$$` substitution engine.
 *
 * Imported by hosts that route secrets to agent runtimes (env / file
 * injection) and by `@agentproto/egress` for the substitution path.
 */

export {
  type SecretExposure,
  type EnvExposure,
  type FileExposure,
  type EgressSubstituteExposure,
  type SecretExposureWrap,
  type SecretExposureWrapContext,
  isExposureKind,
} from "./types.js"

export {
  SECRET_PLACEHOLDER_PATTERN,
  type SecretResolver,
  type SubstituteResult,
  type SubstitutionRecord,
  substituteSecrets,
  formatPlaceholder,
  assertSafeSecretValue,
  SecretSubstitutionError,
} from "./substitute.js"
