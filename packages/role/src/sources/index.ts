/**
 * AIP-47 source loaders.
 *
 * The base interface lives in `types.ts`. Built-in (TS registry) is
 * the only loader the core package ships — file-system and DB loaders
 * live in consumer packages that own those concerns (node fs, Drizzle
 * adapters, …) to keep the core package universal.
 */

export type {
  BuiltinRoleEntry,
  RoleManifestRaw,
  RoleRef,
  RoleSource,
} from "./types.js"

export { BuiltinRoleSource, builtinSourceFromRecord } from "./builtin.js"
