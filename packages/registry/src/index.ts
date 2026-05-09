/**
 * @agentproto/registry — AIP-43 reference implementation.
 *
 * A type-parametric in-memory catalog that collects N defineX'd
 * doctype handles (storage, sandbox, operator, extension, …) and
 * exposes a uniform lookup surface. Replaces hand-rolled per-host
 * registries with one shape that works for every doctype family.
 *
 * @see https://agentproto.sh/docs/aip-43
 */

export const SPEC_NAME = "agentregistry/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { createRegistry } from "./create-registry.js"
export {
  RegistryDuplicateError,
  RegistryKeyError,
  RegistryNotFoundError,
  type Registry,
  type RegistryOptions,
  type SuggestedCapabilities,
} from "./types.js"
